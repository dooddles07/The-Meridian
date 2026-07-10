const mongoose = require('mongoose');
const ghl      = require('../services/ghl.service');
const residents = require('../services/residents.service');
const { Conversation, Message } = require('../models/messaging.model');

// Optional GHL Inbound Webhook — fires on every new message so a GHL workflow can
// notify the other party over WhatsApp / email. URL is the security; non-fatal.
const MESSAGE_WEBHOOK = process.env.MERIDIAN_WEBHOOK_MESSAGE || '';

const dbReady = () => mongoose.connection.readyState === 1;
const preview = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

const fmtMessage = (m) => ({
  id:        String(m._id),
  sender:    m.sender,
  sender_name: m.sender_name || (m.sender === 'management' ? 'Management' : 'Resident'),
  body:      m.body,
  createdAt: m.createdAt,
});

const fmtConversation = (c) => ({
  id:                   String(c._id),
  contact_id:           c.contact_id || '',
  resident_name:        c.resident_name || 'Resident',
  resident_unit:        c.resident_unit || '',
  resident_email:       c.resident_email || '',
  last_message_at:      c.last_message_at || c.updatedAt,
  last_message_preview: c.last_message_preview || '',
  last_sender:          c.last_sender || 'resident',
  unread_management:    c.unread_management || 0,
  unread_resident:      c.unread_resident || 0,
  resolved:             !!c.resolved,
});

// Find the resident's single thread by contact_id (preferred) or email. Optionally
// create it, seeding the resident's identity fields.
async function findConversation({ contact_id, email }) {
  const or = [];
  if (contact_id) or.push({ contact_id });
  if (email)      or.push({ resident_email: String(email).toLowerCase() });
  if (!or.length) return null;
  return Conversation.findOne({ $or: or }).sort({ last_message_at: -1 });
}

async function findOrCreateConversation({ contact_id, email, name, unit }) {
  let convo = await findConversation({ contact_id, email });
  if (!convo) {
    convo = await Conversation.create({
      contact_id:     contact_id || '',
      resident_email: String(email || '').toLowerCase(),
      resident_name:  name || 'Resident',
      resident_unit:  String(unit || '').replace(/^#/, ''),
    });
  } else {
    // Keep identity fields fresh + backfill the contact_id once it's known.
    const set = {};
    if (contact_id && !convo.contact_id) set.contact_id = contact_id;
    if (name && convo.resident_name !== name) set.resident_name = name;
    if (unit) { const u = String(unit).replace(/^#/, ''); if (convo.resident_unit !== u) set.resident_unit = u; }
    if (email && !convo.resident_email) set.resident_email = String(email).toLowerCase();
    if (Object.keys(set).length) { Object.assign(convo, set); await convo.save(); }
  }
  return convo;
}

function fireWebhook(payload) {
  if (!MESSAGE_WEBHOOK) return;
  ghl.postWebhook(MESSAGE_WEBHOOK, payload).catch(e =>
    console.warn('[messages] webhook failed (non-fatal):', e.response?.data?.message || e.message));
}

// ── Resident side ─────────────────────────────────────────────────────────────

// POST /api/messages — resident sends a message to management.
async function sendMessage(req, res) {
  const { contact_id, resident_email, resident_name, resident_unit, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
  if (!contact_id && !resident_email) return res.status(400).json({ success: false, message: 'Could not identify your account. Please log in again.' });
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Messaging is temporarily unavailable. Please try again shortly.' });
  try {
    const convo = await findOrCreateConversation({ contact_id, email: resident_email, name: resident_name, unit: resident_unit });
    const msg = await Message.create({ conversation_id: convo._id, sender: 'resident', sender_name: resident_name || 'Resident', body: String(body).trim() });
    convo.last_message_at      = msg.createdAt;
    convo.last_message_preview = preview(body);
    convo.last_sender          = 'resident';
    convo.unread_management    = (convo.unread_management || 0) + 1;
    if (convo.resolved) { convo.resolved = false; convo.resolved_at = undefined; } // new activity reopens it
    await convo.save();
    fireWebhook({
      event: 'portal_message', direction: 'resident_to_management',
      conversation_id: String(convo._id),
      resident_name: convo.resident_name, resident_unit: convo.resident_unit,
      resident_email: convo.resident_email, contact_id: convo.contact_id,
      body: String(body).trim(),
    });
    return res.json({ success: true, message: fmtMessage(msg) });
  } catch (err) {
    console.error('[messages] send failed:', err.message);
    return res.status(502).json({ success: false, message: 'Could not send your message. Please try again.' });
  }
}

// GET /api/messages/mine?contact_id=&email= — resident's thread; marks management
// messages as read (resets the resident's unread counter).
async function myThread(req, res) {
  const { contact_id, email } = req.query;
  if (!dbReady()) return res.json({ success: true, messages: [], unread: 0 });
  try {
    const convo = await findConversation({ contact_id, email });
    if (!convo) return res.json({ success: true, messages: [], unread: 0 });
    const messages = await Message.find({ conversation_id: convo._id }).sort({ createdAt: 1 }).lean();
    if (convo.unread_resident) { convo.unread_resident = 0; await convo.save(); }
    return res.json({ success: true, conversation: fmtConversation(convo), messages: messages.map(fmtMessage), unread: 0 });
  } catch (err) {
    console.error('[messages] myThread failed:', err.message);
    return res.json({ success: true, messages: [], unread: 0 });
  }
}

// GET /api/messages/unread?contact_id=&email= — unread count for the resident badge.
async function myUnread(req, res) {
  const { contact_id, email } = req.query;
  if (!dbReady()) return res.json({ success: true, unread: 0 });
  try {
    const convo = await findConversation({ contact_id, email });
    return res.json({ success: true, unread: convo ? (convo.unread_resident || 0) : 0 });
  } catch {
    return res.json({ success: true, unread: 0 });
  }
}

// ── Management side ─────────────────────────────────────────────────────────────

// GET /api/management/messages — all conversations, newest activity first.
async function listConversations(req, res) {
  if (!dbReady()) return res.json({ success: true, conversations: [], total_unread: 0 });
  try {
    const rows = await Conversation.find({ active: true }).sort({ last_message_at: -1, updatedAt: -1 }).limit(300).lean();
    const conversations = rows.map(fmtConversation);
    const total_unread  = conversations.reduce((s, c) => s + (c.unread_management || 0), 0);
    return res.json({ success: true, conversations, total_unread });
  } catch (err) {
    console.error('[messages] list failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/management/messages/:id — full thread; marks resident messages as read.
async function getConversation(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    const messages = await Message.find({ conversation_id: convo._id }).sort({ createdAt: 1 }).lean();
    if (convo.unread_management) { convo.unread_management = 0; await convo.save(); }
    return res.json({ success: true, conversation: fmtConversation(convo), messages: messages.map(fmtMessage) });
  } catch (err) {
    console.error('[messages] get failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// POST /api/management/messages/:id/reply — management replies in a thread.
async function replyConversation(req, res) {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ success: false, message: 'Reply cannot be empty.' });
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    return res.json(await appendManagementMessage(convo, body, req.user));
  } catch (err) {
    console.error('[messages] reply failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// POST /api/management/messages/:id/resolve — mark a conversation resolved / reopen it.
// Body: { resolved: true|false } (defaults to true).
async function resolveConversation(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    const resolved = req.body && typeof req.body.resolved === 'boolean' ? req.body.resolved : true;
    convo.resolved    = resolved;
    convo.resolved_at = resolved ? new Date() : undefined;
    await convo.save();
    return res.json({ success: true, conversation: fmtConversation(convo) });
  } catch (err) {
    console.error('[messages] resolve failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// POST /api/management/messages/start — management starts (or appends to) a thread
// with a specific resident chosen from the directory.
async function startConversation(req, res) {
  const { contact_id, resident_email, resident_name, resident_unit, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
  if (!contact_id && !resident_email) return res.status(400).json({ success: false, message: 'Please choose a resident to message.' });
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const convo = await findOrCreateConversation({ contact_id, email: resident_email, name: resident_name, unit: resident_unit });
    const result = await appendManagementMessage(convo, body, req.user);
    return res.json({ ...result, conversation_id: String(convo._id) });
  } catch (err) {
    console.error('[messages] start failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// Shared: append a management message to a thread + bump the resident's unread.
async function appendManagementMessage(convo, body, user) {
  const senderName = (user && (user.displayName || user.username)) || 'Management';
  const msg = await Message.create({ conversation_id: convo._id, sender: 'management', sender_name: senderName, body: String(body).trim() });
  convo.last_message_at      = msg.createdAt;
  convo.last_message_preview = preview(body);
  convo.last_sender          = 'management';
  convo.unread_resident      = (convo.unread_resident || 0) + 1;
  await convo.save();
  fireWebhook({
    event: 'portal_message', direction: 'management_to_resident',
    conversation_id: String(convo._id),
    resident_name: convo.resident_name, resident_unit: convo.resident_unit,
    resident_email: convo.resident_email, contact_id: convo.contact_id,
    sender_name: senderName, body: String(body).trim(),
  });
  return { success: true, message: fmtMessage(msg) };
}

// GET /api/management/messages-residents — resident directory for the composer.
async function listMessageResidents(req, res) {
  try {
    const rows = await residents.listResidents();
    const list = (rows || []).map(r => ({
      name:       r.name || r.email || '(no name)',
      unit:       String(r.unit || '').replace(/^#/, ''),
      email:      r.email || '',
      contact_id: r.ghl_contact_id || '',
    })).sort((a, b) => a.unit.localeCompare(b.unit));
    return res.json({ success: true, residents: list });
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = {
  sendMessage, myThread, myUnread,
  listConversations, getConversation, replyConversation, resolveConversation, startConversation, listMessageResidents,
};
