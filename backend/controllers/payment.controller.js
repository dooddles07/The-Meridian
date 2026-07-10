const crypto   = require('crypto');
const mongoose = require('mongoose');
const Payment  = require('../models/payment.model');
const ghl      = require('../services/ghl.service');
const { getPipeline } = require('../config/pipelines');

const dbReady = () => mongoose.connection.readyState === 1;

// Shared secret the payment provider (Wibiz/GHL) must present on the success
// webhook. This is what proves a confirmation came from a REAL, completed payment
// rather than a forged request. Set LUMINA_PAYMENT_WEBHOOK_SECRET in the env and
// configure the GHL/Wibiz webhook to send it (header x-lumina-webhook-secret, or a
// `secret` field in the body). Fails CLOSED: with no secret configured, confirmations
// are rejected — a booking can never be confirmed by an unauthenticated caller.
const WEBHOOK_SECRET = process.env.LUMINA_PAYMENT_WEBHOOK_SECRET || '';

function verifyWebhookSecret(req) {
  if (!WEBHOOK_SECRET) return false;                         // not configured → reject all
  const provided = String(req.get('x-lumina-webhook-secret') || (req.body && req.body.secret) || '');
  if (!provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);  // constant-time compare
}

// Deposit amounts (SGD) per deposit-required facility + move. Override via env.
// Move is collected as one payment: SGD 200 admin fee + SGD 2000 refundable deposit
// = SGD 2200 total. On completion the SGD 2000 deposit is refunded (MOVE_REFUNDABLE).
const MOVE_ADMIN_FEE  = Number(process.env.LUMINA_MOVE_ADMIN_FEE  || 200);
const MOVE_REFUNDABLE = Number(process.env.LUMINA_MOVE_REFUNDABLE || 2000);
const DEPOSITS = {
  bbq:      Number(process.env.LUMINA_DEPOSIT_BBQ      || 200),
  pool:     Number(process.env.LUMINA_DEPOSIT_POOL     || 200),
  verandah: Number(process.env.LUMINA_DEPOSIT_VERANDAH || 600),
  move:     Number(process.env.LUMINA_DEPOSIT_MOVE     || (MOVE_ADMIN_FEE + MOVE_REFUNDABLE)),
  default:  Number(process.env.LUMINA_DEPOSIT_DEFAULT  || 50),
};

const fmt = (p) => ({
  id:             String(p._id),
  description:    p.description,
  amount:         p.amount,
  currency:       p.currency || 'SGD',
  category:       p.category || 'General',
  status:         p.status || 'pending',
  reference:      p.reference || '',
  opportunity_id: p.opportunity_id || '',
  fee_label:      p.fee_label || '',
  resident_unit:  p.resident_unit || '',
  resident_email: p.resident_email || '',
  paid_at:        p.paid_at || null,
  due_at:         p.due_at || null,
  createdAt:      p.createdAt,
});

// GET /api/payments/mine?contact_id=&email= — resident's payment history (newest first).
async function myPayments(req, res) {
  const { contact_id, email } = req.query;
  if (!dbReady()) return res.json({ success: true, payments: [] });
  const or = [];
  if (contact_id) or.push({ contact_id });
  if (email)      or.push({ resident_email: String(email).toLowerCase() });
  if (!or.length) return res.json({ success: true, payments: [] });
  try {
    const rows = await Payment.find({ $or: or }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, payments: rows.map(fmt) });
  } catch (err) {
    console.error('[payments] list failed:', err.message);
    return res.json({ success: true, payments: [] });
  }
}

// POST /api/payments/pay-deposit — resident pays a booking/move deposit. Verandah's
// booking fee + refundable deposit are now a single combined payment; other
// facilities and moves use a single fee → Confirmed.
// Body: { pipeline, opportunity_id, facility_key?, fee_label?, fee_amount?,
//         description, contact_id, email, name, unit }
const VERANDAH_FEE_AMOUNTS = { deposit: 600 };
const VERANDAH_FEE_LABELS  = ['deposit'];

async function payDeposit(req, res) {
  const { pipeline, opportunity_id, facility_key, fee_label, fee_amount, description, contact_id, email, name, unit } = req.body || {};
  if (!opportunity_id) return res.status(400).json({ success: false, message: 'Missing booking reference.' });
  if (!['facility', 'move'].includes(pipeline)) return res.status(400).json({ success: false, message: 'Invalid payment type.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'Payments are temporarily unavailable.' });

  // A resident may only confirm THEIR OWN booking. The auth middleware injects the
  // caller's contact_id from the signed token, so verify the opportunity belongs to
  // it before advancing. Management callers are trusted operators — skip the check.
  if (req.user && req.user.role === 'resident') {
    const callerContact = String(contact_id || '').trim();
    if (callerContact) {
      try {
        const data       = await ghl.ghlGet(`/opportunities/${opportunity_id}`);
        const opp        = data.opportunity || data;
        const oppContact = String((opp.contact && opp.contact.id) || opp.contactId || '');
        if (oppContact && oppContact !== callerContact) {
          return res.status(403).json({ success: false, message: 'You can only pay for your own booking.' });
        }
      } catch (e) {
        return res.status(502).json({ success: false, message: 'Could not verify the booking. Please try again.' });
      }
    }
  }

  const pl = getPipeline(pipeline);
  const confirmedStage = pl && pl.stages.Confirmed;
  if (!confirmedStage) return res.status(500).json({ success: false, message: 'Booking pipeline misconfigured.' });

  const isVerandahFee = facility_key === 'verandah' && VERANDAH_FEE_LABELS.includes(fee_label);

  if (isVerandahFee) {
    // Verandah fee path: record this fee, confirm GHL once all required fees are present.
    const amount = VERANDAH_FEE_AMOUNTS[fee_label];
    try {
      if (dbReady()) {
        const already = await Payment.findOne({ opportunity_id, fee_label }).lean();
        if (!already) {
          await Payment.create({
            contact_id: contact_id || '', resident_email: String(email || '').toLowerCase(), resident_unit: unit || '',
            description: description || 'Verandah Booking Fee + Refundable Deposit',
            amount, currency: 'SGD', category: 'Deposit', status: 'paid',
            reference: `DEP-${String(opportunity_id).slice(-6).toUpperCase()}-${fee_label.slice(0,3).toUpperCase()}`,
            opportunity_id, fee_label, paid_at: new Date(),
          });
        }
        // Confirm GHL once all required fees are recorded.
        const paidFees = await Payment.find({ opportunity_id, fee_label: { $in: VERANDAH_FEE_LABELS } }).lean();
        const paidLabels = new Set(paidFees.map(f => f.fee_label));
        const bothPaid = VERANDAH_FEE_LABELS.every(l => paidLabels.has(l));
        if (bothPaid) {
          await ghl.ghlPut(`/opportunities/${opportunity_id}`, { pipelineId: pl.id, pipelineStageId: confirmedStage }, { version: '2021-07-28' });
          return res.json({ success: true, partial: false, both_paid: true, message: 'Both fees paid — your booking is now confirmed.', amount, stage: 'Confirmed' });
        }
        return res.json({ success: true, partial: true, both_paid: false, message: 'Fee recorded. Pay the remaining fee to confirm your booking.', amount });
      }
      return res.json({ success: true, partial: true, message: 'Fee noted. Pay the remaining fee to confirm your booking.', amount });
    } catch (err) {
      console.error('[payments] verandah fee failed:', err.message);
      return res.status(502).json({ success: false, message: 'Could not record this payment. Please try again.' });
    }
  }

  // Standard path: single fee → record + confirm GHL immediately.
  const amount = pipeline === 'facility' ? (DEPOSITS[facility_key] || DEPOSITS.default) : DEPOSITS.move;
  try {
    // Idempotent: if this opp already has a payment recorded, don't double-record or
    // re-fire (guards against a double-click or the poll racing the Done button).
    if (dbReady()) {
      const already = await Payment.findOne({ opportunity_id }).lean();
      if (already) return res.json({ success: true, message: 'Your booking is already confirmed.', amount, stage: 'Confirmed' });
    }
    await ghl.ghlPut(`/opportunities/${opportunity_id}`, { pipelineId: pl.id, pipelineStageId: confirmedStage }, { version: '2021-07-28' });
    if (dbReady()) {
      await Payment.create({
        contact_id: contact_id || '', resident_email: String(email || '').toLowerCase(), resident_unit: unit || '',
        description: description || 'Booking deposit', amount, currency: 'SGD', category: 'Deposit',
        status: 'paid', reference: `DEP-${String(opportunity_id).slice(-6).toUpperCase()}`,
        opportunity_id, paid_at: new Date(),
      }).catch(e => console.warn('[payments] record failed (non-fatal):', e.message));
    }
    return res.json({ success: true, message: 'Deposit paid — your booking is now confirmed.', amount, stage: 'Confirmed' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Payment failed.';
    console.error('[payments] pay-deposit failed:', msg);
    return res.status(502).json({ success: false, message: 'Could not process the deposit. Please try again.' });
  }
}

// POST /api/payments/confirm — called by GHL payment-link success workflow.
// Finds the Deposit Pending facility opp for the contact, records the fee to DB,
// and moves GHL stage to Confirmed once all required fees are recorded.
// Body: { contact_id, fee_label }
// GHL workflow: Inbound Webhook action → POST this URL with the fields above.
async function confirmPayment(req, res) {
  // A confirmation = a booking gets marked paid and advanced. Only the payment
  // provider's verified webhook may do this. Reject anything without the secret.
  if (!verifyWebhookSecret(req)) {
    console.warn('[payments/confirm] rejected — missing or invalid webhook secret');
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  const { contact_id, fee_label } = req.body || {};
  if (!contact_id) return res.status(400).json({ success: false, message: 'contact_id required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });

  const fp = getPipeline('facility');
  if (!fp) return res.status(500).json({ success: false, message: 'Facility pipeline not configured.' });

  try {
    // Find the Deposit Pending opp for this contact.
    const data = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, pipeline_id: fp.id, contact_id, limit: 50 },
    });
    const DEPOSIT_STAGE_IDS = new Set(
      ['Deposit Pending', 'Requested'].map(s => fp.stages[s]).filter(Boolean)
    );
    const opp = (data.opportunities || [])
      .filter(o => DEPOSIT_STAGE_IDS.has(o.pipelineStageId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (!opp) {
      console.warn(`[payments/confirm] no Deposit Pending opp found for contact ${contact_id}`);
      return res.json({ success: true, message: 'No pending deposit found — may already be confirmed.' });
    }

    const oppId       = opp.id;
    const oppName     = (opp.name || '').toLowerCase();
    const isVerandah  = oppName.includes('verandah');
    const confirmedId = fp.stages.Confirmed;

    if (isVerandah && VERANDAH_FEE_LABELS.includes(fee_label)) {
      // Record this fee if not already.
      if (dbReady()) {
        const already = await Payment.findOne({ opportunity_id: oppId, fee_label }).lean();
        if (!already) {
          await Payment.create({
            contact_id, description: 'Verandah Booking Fee + Refundable Deposit',
            amount: VERANDAH_FEE_AMOUNTS[fee_label], currency: 'SGD', category: 'Deposit', status: 'paid',
            reference: `DEP-${oppId.slice(-6).toUpperCase()}-${fee_label.slice(0, 3).toUpperCase()}`,
            opportunity_id: oppId, fee_label, paid_at: new Date(),
          });
        }
        const paidFees   = await Payment.find({ opportunity_id: oppId, fee_label: { $in: VERANDAH_FEE_LABELS } }).lean();
        const paidLabels = new Set(paidFees.map(f => f.fee_label));
        const bothPaid   = VERANDAH_FEE_LABELS.every(l => paidLabels.has(l));
        if (bothPaid) {
          await ghl.ghlPut(`/opportunities/${oppId}`, { pipelineId: fp.id, pipelineStageId: confirmedId }, { version: '2021-07-28' });
          console.log(`[payments/confirm] Verandah ${oppId} — both fees paid, moved to Confirmed`);
          return res.json({ success: true, both_paid: true, message: 'Both fees paid — booking confirmed.' });
        }
        console.log(`[payments/confirm] Verandah ${oppId} — ${fee_label} recorded, awaiting other fee`);
        return res.json({ success: true, both_paid: false, message: `${fee_label} recorded. Awaiting remaining fee.` });
      }
    }

    // Non-Verandah or no fee_label: single payment → confirm immediately.
    // Idempotent: if we've already recorded a payment for this opp, don't double-process.
    if (dbReady()) {
      const already = await Payment.findOne({ opportunity_id: oppId }).lean();
      if (already) {
        console.log(`[payments/confirm] opp ${oppId} already recorded — skipping duplicate`);
        return res.json({ success: true, message: 'Booking already confirmed.' });
      }
    }
    await ghl.ghlPut(`/opportunities/${oppId}`, { pipelineId: fp.id, pipelineStageId: confirmedId }, { version: '2021-07-28' });
    if (dbReady()) {
      await Payment.create({
        contact_id, description: 'Booking deposit', amount: 0, currency: 'SGD',
        category: 'Deposit', status: 'paid', reference: `DEP-${oppId.slice(-6).toUpperCase()}`,
        opportunity_id: oppId, paid_at: new Date(),
      }).catch(() => {});
    }
    console.log(`[payments/confirm] opp ${oppId} moved to Confirmed`);
    return res.json({ success: true, message: 'Booking confirmed.' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[payments/confirm] failed:', msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

// GET /api/management/payments — all payment records (management).
async function allPayments(req, res) {
  if (!dbReady()) return res.json({ success: true, payments: [] });
  try {
    const rows = await Payment.find().sort({ createdAt: -1 }).limit(500).lean();
    return res.json({ success: true, payments: rows.map(fmt) });
  } catch (err) {
    console.error('[payments] all failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = { myPayments, payDeposit, confirmPayment, allPayments };
