/*
 * client-backend.js - PORTFOLIO PROJECT
 *
 * Makes The Lumina portal run with ZERO backend and ZERO external connections.
 * It must be loaded BEFORE each portal's controller script. It does three things:
 *
 *   1. Auto-enters every portal (no login) by seeding a preview session.
 *   2. Overrides window.fetch to intercept every "/api/..." request and answer it
 *      from an in-browser store (localStorage) - nothing ever hits the network.
 *   3. Seeds realistic sample data so every screen is populated.
 *
 * All three portals (resident / management / guardhouse) share the same browser
 * store, so actions in one show up in another (e.g. a booking a resident makes
 * appears in the management table; a guest registration is findable at the
 * guardhouse). Data lives only in this browser and resets if you clear storage
 * or call window.__luminaReset().
 */
(function () {
  'use strict';

  // Preview identities (used to auto-enter each portal)
  var MEMBER = { name: 'Alex Tan', initials: 'AT', email: 'alex.tan@example.com', unit: '12-09', type: 'Owner', contact_id: 'local-contact-1' };
  var MGMT_USER   = { username: 'management', role: 'management', displayName: 'Management' };
  var GH_USER     = { username: 'guardhouse', role: 'guardhouse', displayName: 'Guardhouse' };

  // Fixed accounts behind the zero-click preview — not real secrets, just public
  // preview credentials with no sensitive data behind them (see residents.service.js's
  // seedPreviewAccount and the LUMINA_MANAGEMENT env account).
  var PREVIEW_RESIDENT   = { email: 'alex.tan@preview.thelumina.app', password: 'LuminaPreview2026!' };
  var PREVIEW_MANAGEMENT = { username: 'admin', password: 'hBJSjqnm7OrqAa1!' };

  // Resident and management logins share one session cookie name, so establishing
  // both in the background on the same page load would let one silently overwrite
  // the other. Scope each real login to the one portal page that actually needs it.
  var PATH = location.pathname;
  var onResidentPortal   = PATH.indexOf('portal.html') !== -1;
  var onManagementPortal = PATH.indexOf('management.html') !== -1;

  function seedSession() {
    try {
      // Resident and management are gated independently — each has its own real
      // login now, so logging out of (or into) one must not affect the other.
      // Don't clobber a real signup/login session, and don't re-enter automatically
      // right after an explicit logout — either way, a login click clears the
      // relevant flag, and the next full reload with no session re-seeds the preview.
      if (localStorage.getItem('lumina_signed_out') !== '1' && !localStorage.getItem('lumina_token')) {
        var mem = JSON.stringify(MEMBER);
        localStorage.setItem('lumina_member', mem);   sessionStorage.setItem('lumina_member', mem);
        localStorage.setItem('lumina_token', 'local-token'); sessionStorage.setItem('lumina_token', 'local-token');
        // Also establish a REAL httpOnly cookie session in the background so
        // genuinely Mongo-backed features (e.g. Resources) work for the preview
        // too — fire-and-forget, so it adds zero latency to the instant boot
        // above. Uses the native fetch (the mock override below hasn't been
        // installed yet at this point in the script).
        if (onResidentPortal) {
          fetch('/api/auth/resident/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(PREVIEW_RESIDENT),
          }).catch(function () {});
        }
      }
      if (localStorage.getItem('lumina_mgmt_signed_out') !== '1' && !localStorage.getItem('mgmtUser')) {
        localStorage.setItem('mgmtUser', JSON.stringify(MGMT_USER)); sessionStorage.setItem('mgmtUser', JSON.stringify(MGMT_USER));
        if (onManagementPortal) {
          fetch('/api/auth/management/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(PREVIEW_MANAGEMENT),
          }).catch(function () {});
        }
      }
      if (localStorage.getItem('lumina_gh_signed_out') !== '1' && !sessionStorage.getItem('gh_session')) {
        sessionStorage.setItem('gh_session', JSON.stringify({ success: true, token: 'local-token', user: GH_USER }));
      }
    } catch (e) { /* storage may be blocked; the mock still answers */ }
  }
  seedSession();

  // Stage vocabularies (mirror config/pipelines.js)
  var STAGES = {
    facility: ['Deposit Pending', 'Confirmed', 'Completed', 'No-Show', 'Cancelled'],
    guest:    ['Registered', 'Checked In', 'Checked Out', 'Departed', 'Closed'],
    parcel:   ['Received', 'Notified', 'Collected', 'Uncollected / Returned'],
    defect:   ['Reported', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'],
    feedback: ['Submitted', 'Under Review', 'Resolved', 'Closed'],
    move:     ['Deposit Pending', 'Confirmed', 'Completed', 'Deposit Refunded'],
  };
  var PIPELINE_IDS = {
    facility: 'local-pipeline-facility', guest: 'local-pipeline-guest', parcel: 'local-pipeline-parcel',
    defect: 'local-pipeline-defect', feedback: 'local-pipeline-feedback', move: 'local-pipeline-move',
  };
  var DEPOSIT_FACILITIES = { bbq: true, pool: true, verandah: true };

  // Store
  var DB_KEY = 'lumina_db_v2';
  var db = load();
  if (!db) { db = seedDB(); persist(); }

  function load() { try { return JSON.parse(localStorage.getItem(DB_KEY)) || null; } catch (e) { return null; } }
  function persist() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {} }
  function uid(p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 9); }
  function nowISO() { return new Date().toISOString(); }
  function daysFromNow(n) { var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function guestRef(date) { return 'GST-' + String(date || daysFromNow(0)).replace(/-/g, '') + '-' + Math.floor(1000 + Math.random() * 9000); }

  window.__luminaReset = function () { localStorage.removeItem(DB_KEY); location.reload(); };

  function seedDB() {
    var me = MEMBER;
    var d = {
      residents: [
        { name: 'Alex Tan', unit: '12-09', email: 'alex.tan@example.com', phone: '+65 9123 4567', type: 'Owner', ghlLinked: true, contact_id: 'local-contact-1' },
        { name: 'Priya Nair', unit: '05-11', email: 'priya.nair@example.com', phone: '+65 9222 1188', type: 'Owner', ghlLinked: true, contact_id: 'local-contact-2' },
        { name: 'Marcus Lee', unit: '18-02', email: 'marcus.lee@example.com', phone: '+65 9777 4321', type: 'Tenant', ghlLinked: true, contact_id: 'local-contact-3' },
        { name: 'Sofia Reyes', unit: '09-14', email: 'sofia.reyes@example.com', phone: '+65 9345 8890', type: 'Owner', ghlLinked: false, contact_id: 'local-contact-4' },
      ],
      bookings: [
        row('Confirmed',      'pool',   'Swimming Pool', '🏊', me, daysFromNow(2),  '9:00 AM - 10:00 AM', 2, ''),
        row('Deposit Pending','bbq',    'BBQ Pit',       '🍖', me, daysFromNow(5),  '6:00 PM - 8:00 PM',  8, 'Family gathering'),
        row('Completed',      'tennis', 'Tennis Court',  '🎾', me, daysFromNow(-6), '7:00 AM - 8:00 AM',  2, ''),
      ],
      guests: [
        guest('Jane Lim',   'jane.lim@example.com',   '+65 9800 1122', 'Family & Friends', daysFromNow(1), 'Registered',  me),
        guest('David Wong', 'david.wong@example.com', '+65 9800 3344', 'Contractor',       daysFromNow(0), 'Checked In',  me),
      ],
      parcels: [
        parcel('SF-88213004', 'SingPost', 'Small box', '', 'Notified', me),
        parcel('LZ-40021199', 'Ninja Van', 'Documents envelope', 'Priya Nair', 'Received', me),
      ],
      defects: [
        defect('Leaking tap in master bathroom', 'Plumbing', '#12-08 Master Bath', 'High', 'Acknowledged', me),
        defect('Corridor light flickering on level 12', 'Electrical', 'Level 12 lift lobby', 'Medium', 'In Progress', me),
      ],
      feedback: [
        feedback('Complaint', 'Noise', 'Renovation noise past permitted hours on level 11.', daysFromNow(-3), '21:30', 'Under Review', me),
        feedback('Suggestion', 'Community Events', 'Please organise a weekend farmers market at the verandah.', '', '', 'Submitted', me),
      ],
      moves: [
        move('Move-In', daysFromNow(9), '10:00 AM - 1:00 PM', 'Bulky furniture, need service lift.', 'Deposit Pending', me),
      ],
      payments: [
        pay('BBQ Pit - refundable deposit', 200, 'Deposit', 'paid',    'DEP-BBQ001', 'local-opp-bbq',  '', me),
        pay('Move-In - admin fee + deposit', 2200, 'Deposit', 'paid',   'DEP-MOV001', 'local-opp-move', '', me),
      ],
      announcements: [
        ann('Scheduled Water Tank Cleaning', 'Water supply will be interrupted on the maintenance date below. Please store water in advance.', 'Maintenance', { pinned: true, eventAt: daysFromNow(4) + 'T09:00:00+08:00', eventEndAt: daysFromNow(4) + 'T14:00:00+08:00', blocked_facilities: ['pool'] }),
        ann('Annual General Meeting 2026', 'All residents are invited to the AGM at the function room. Please RSVP so we can plan seating.', 'Event', { rsvp_enabled: true, eventAt: daysFromNow(14) + 'T19:30:00+08:00', event_venue: 'Function Room' }),
        ann('New Recycling Guidelines', 'Updated recycling bin locations and sorting rules are now in effect across all blocks.', 'General', {}),
      ],
      rsvps: {},               // { [annId]: { [contactId]: {response, attendee_count, resident_name, resident_unit, updatedAt} } }
      conversations: [
        convo(me, [
          { sender: 'resident',   sender_name: 'Alex Tan',   body: 'Hi, could you confirm the visitor parking rules for weekends?', minsAgo: 180 },
          { sender: 'management', sender_name: 'Management', body: 'Hello Alex - weekend visitor parking is free up to 4 hours at lots V1 - V8. Just register the vehicle at the guardhouse.', minsAgo: 120 },
        ], false),
      ],
      resources: [
        resource('House Rules & By-Laws', 'Policies', 'house-rules.txt', 'text/plain'),
        resource('Facility Booking Guide', 'Guides', 'facility-guide.txt', 'text/plain'),
        resource('Fire Evacuation Plan', 'Safety', 'evacuation-plan.txt', 'text/plain'),
      ],
      guardLog: [],
    };
    return d;

    function row(status, key, name, emoji, m, date, slot, pax, notes) {
      var id = uid('local-appt');
      return { id: id, facilityKey: key, facility: name, facilityName: name, emoji: emoji, resident: m.name, unit: m.unit, pax: pax, date: date, slot: slot, notes: notes, status: status, stage: status, oppId: uid('local-opp'), contactId: m.contact_id };
    }
    function guest(visitor, email, phone, type, date, stage, m) {
      return { oppId: uid('local-opp'), contactId: m.contact_id, reference: guestRef(date), visitor: visitor, visitorEmail: email, visitorPhone: phone, visitorType: type, host: m.name, unit: m.unit, phone: phone, visitDate: date, duration: 'Single Visit (Day)', stage: stage, createdAt: nowISO() };
    }
    function parcel(ref, courier, desc, collector, stage, m) {
      return { id: uid('local-parcel'), opportunityId: uid('local-opp'), contactId: m.contact_id, ref: ref, courier: courier, desc: desc, collector: collector, resident: m.name, unit: m.unit, stage: stage, ts: nowISO() };
    }
    function defect(desc, category, location, urgency, stage, m) {
      return { id: uid('local-defect'), opportunityId: uid('local-opp'), contactId: m.contact_id, desc: desc, category: category, location: location, urgency: urgency, stage: stage, contact: m.name, unit: m.unit, ts: nowISO() };
    }
    function feedback(type, category, desc, idate, itime, stage, m) {
      return { id: uid('local-fb'), opportunityId: uid('local-opp'), contactId: m.contact_id, type: type, category: category, desc: desc, incident_date: idate, incident_time: itime, stage: stage, contact: m.name, unit: m.unit, ts: nowISO() };
    }
    function move(type, date, time, notes, stage, m) {
      return { id: uid('local-move'), opportunityId: uid('local-opp'), contactId: m.contact_id, move_type: type, move_date: date, move_time: time, notes: notes, stage: stage, contact: m.name, unit: m.unit, ts: nowISO() };
    }
    function pay(desc, amount, category, status, ref, oppId, fee, m) {
      return { id: uid('local-pay'), description: desc, amount: amount, currency: 'SGD', category: category, status: status, reference: ref, opportunity_id: oppId, fee_label: fee, resident_unit: m.unit, resident_email: m.email, paid_at: status === 'paid' ? nowISO() : null, due_at: null, createdAt: nowISO() };
    }
    function ann(title, body, category, opt) {
      opt = opt || {};
      return { id: uid('local-ann'), title: title, body: body, category: category, eventAt: opt.eventAt || null, eventEndAt: opt.eventEndAt || null, pinned: !!opt.pinned, rsvp_enabled: !!opt.rsvp_enabled, blocked_facilities: opt.blocked_facilities || [], event_venue: opt.event_venue || '', createdAt: nowISO() };
    }
    function convo(m, msgs, resolved) {
      var messages = msgs.map(function (x) {
        return { id: uid('local-msg'), sender: x.sender, sender_name: x.sender_name, body: x.body, createdAt: new Date(Date.now() - x.minsAgo * 60000).toISOString() };
      });
      var last = messages[messages.length - 1];
      return { id: uid('local-convo'), contact_id: m.contact_id, resident_name: m.name, resident_unit: m.unit, resident_email: m.email, last_message_at: last.createdAt, last_message_preview: last.body.slice(0, 80), last_sender: last.sender, unread_management: 0, unread_resident: 0, resolved: !!resolved, messages: messages };
    }
    function resource(title, category, fileName, fileType) {
      var text = 'The Lumina · ' + title + '\n\nThis is a sample document included with this portfolio build.';
      var data = 'data:' + fileType + ';base64,' + btoa(unescape(encodeURIComponent(text)));
      return { id: uid('local-res'), title: title, category: category, visibility: 'residents', file_data: data, file_name: fileName, file_type: fileType, file_size: text.length, uploaded_by: 'Management', createdAt: nowISO() };
    }
  }

  // Response helpers
  function J(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function ok(extra) { return J(Object.assign({ success: true }, extra || {})); }

  // Map a stored collection item → the generic "opportunity" shape the resident
  // "My …" panels and the management pipeline tables consume.
  function oppName(kind, it) {
    if (kind === 'guest')   return it.reference + '' + it.visitor + ' (#' + it.unit + ')';
    if (kind === 'parcel')  return it.ref + '' + it.resident + ' (#' + it.unit + ')' + (it.collector ? ' [Auth: ' + it.collector + ']' : '');
    if (kind === 'defect')  return (it.category ? it.category + ': ' : '') + it.desc;
    if (kind === 'feedback')return (it.type ? it.type + '' : '') + it.desc;
    if (kind === 'move')    return it.move_type + '' + it.contact + ' (#' + it.unit + ') · ' + it.move_date + ' ' + it.move_time;
    return it.desc || it.name || '';
  }
  function toOpp(kind, it) {
    return { id: it.oppId || it.opportunityId || it.id, name: oppName(kind, it), stage: it.stage, pipelineId: PIPELINE_IDS[kind], createdAt: it.ts || it.createdAt || nowISO(), customFields: [] };
  }
  function collectionFor(kind) {
    return { guest: db.guests, parcel: db.parcels, defect: db.defects, feedback: db.feedback, move: db.moves }[kind] || [];
  }
  function setStageById(list, id, stage) {
    var hit = list.find(function (x) { return (x.oppId || x.opportunityId || x.id) === id; });
    if (hit) { hit.stage = stage; persist(); return true; }
    return false;
  }

  // Router
  function handle(rawUrl, opts) {
    var u = new URL(rawUrl, location.origin);
    var p = u.pathname.replace(/\/+$/, '') || u.pathname; // trim trailing slash (but keep "/api")
    var qs = u.searchParams;
    var method = (opts.method || 'GET').toUpperCase();
    var body = {};
    if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = {}; } }
    var m; // regex capture holder

    // AUTH — resident, management, and guardhouse login are all handled by the
    // real backend now (see the fetch override above, which passes each
    // /api/auth/*/login straight through instead of reaching this router).

    // PIPELINES
    if (p === '/api/pipelines') {
      var out = {}; Object.keys(PIPELINE_IDS).forEach(function (k) { out[k] = { id: PIPELINE_IDS[k], name: k, stages: STAGES[k] }; });
      return ok({ count: Object.keys(out).length, pipelines: out });
    }
    if (p === '/api/pipelines/verify') return ok({ allOk: true, report: {} });

    // BOOKING
    if (p === '/api/booking/availability') return ok({ busy: [] });
    if (p === '/api/booking/opp-stage')    return ok({ stage: 'Confirmed' });
    if (p === '/api/booking/mine') {
      var mine = db.bookings;
      var statuses = {}; mine.forEach(function (b) { statuses[b.id] = b.status; });
      return ok({ items: mine, statuses: statuses, stages: STAGES.facility });
    }
    if (p === '/api/booking' && method === 'POST') {
      var fk = body.facilityKey;
      var status = DEPOSIT_FACILITIES[fk] ? 'Deposit Pending' : 'Confirmed';
      var id = uid('local-appt');
      db.bookings.push({
        id: id, facilityKey: fk, facility: body.facilityName || fk, facilityName: body.facilityName || fk,
        emoji: body.emoji || '', resident: body.member_name || MEMBER.name, unit: body.member_unit || MEMBER.unit,
        pax: body.pax || 1, date: body.date, slot: body.slot, notes: body.notes || '', status: status, stage: status,
        oppId: uid('local-opp'), contactId: body.contact_id || MEMBER.contact_id,
      });
      persist();
      return ok({ message: 'Booking confirmed.', appointmentId: id, calendarId: 'local-cal-' + fk, pipelineConnected: true });
    }
    if ((m = p.match(/^\/api\/booking\/([^/]+)$/)) && method === 'PUT') {
      var b1 = db.bookings.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      if (b1) { b1.date = body.date || b1.date; b1.slot = body.slot || b1.slot; b1.pax = body.pax || b1.pax; b1.notes = body.notes != null ? body.notes : b1.notes; persist(); }
      return ok({ message: 'Booking updated.' });
    }
    if ((m = p.match(/^\/api\/booking\/([^/]+)$/)) && method === 'DELETE') {
      var b2 = db.bookings.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      if (b2) { b2.status = 'Cancelled'; b2.stage = 'Cancelled'; persist(); }
      return ok({ message: 'Booking cancelled.', mongoCancelled: true, oppMoved: true, apptCancelled: true });
    }

    // OPPORTUNITIES (resident "My …")
    if (p === '/api/opportunities') {
      var kind = qs.get('pipeline') || 'guest';
      var items = collectionFor(kind).map(function (it) { return toOpp(kind, it); });
      return ok({ items: items, total: items.length });
    }

    // ANNOUNCEMENTS / RSVP / MESSAGES (resident)
    if (p === '/api/announcements') return ok({ announcements: db.announcements });

    if (p === '/api/rsvp' && method === 'POST') {
      var aId = body.announcement_id, cId = body.contact_id || MEMBER.contact_id;
      db.rsvps[aId] = db.rsvps[aId] || {};
      db.rsvps[aId][cId] = { response: body.response, attendee_count: body.attendee_count || 1, resident_name: body.resident_name || MEMBER.name, resident_unit: body.resident_unit || MEMBER.unit, updatedAt: nowISO() };
      persist();
      return ok({ response: body.response, attendee_count: body.attendee_count || 1 });
    }
    if (p === '/api/rsvp/mine') {
      var cid = qs.get('contact_id') || MEMBER.contact_id, r = {};
      Object.keys(db.rsvps).forEach(function (a) { if (db.rsvps[a][cid]) r[a] = { response: db.rsvps[a][cid].response, attendee_count: db.rsvps[a][cid].attendee_count }; });
      return ok({ rsvps: r });
    }

    if (p === '/api/messages/mine') {
      var c = db.conversations[0];
      if (!c) return ok({ messages: [], unread: 0 });
      return ok({ conversation: convoMeta(c), messages: c.messages, unread: c.unread_resident || 0 });
    }
    if (p === '/api/messages/unread') { var cc = db.conversations[0]; return ok({ unread: cc ? (cc.unread_resident || 0) : 0 }); }
    if (p === '/api/messages' && method === 'POST') {
      var conv = db.conversations[0];
      if (!conv) { conv = { id: uid('local-convo'), contact_id: MEMBER.contact_id, resident_name: MEMBER.name, resident_unit: MEMBER.unit, resident_email: MEMBER.email, unread_management: 0, unread_resident: 0, resolved: false, messages: [] }; db.conversations.push(conv); }
      var msg = { id: uid('local-msg'), sender: 'resident', sender_name: MEMBER.name, body: body.body, createdAt: nowISO() };
      conv.messages.push(msg); conv.last_message_at = msg.createdAt; conv.last_message_preview = body.body.slice(0, 80); conv.last_sender = 'resident'; conv.unread_management += 1; conv.resolved = false;
      persist();
      return ok({ message: msg });
    }

    // PAYMENTS
    if (p === '/api/payments/mine') return ok({ payments: db.payments });
    if (p === '/api/payments/pay-deposit' && method === 'POST') {
      var amt = body.fee_amount || (body.facility_key === 'verandah' ? 600 : body.pipeline === 'move' ? 2200 : 200);
      // Confirm the matching booking (by oppId) so the resident + management see it move.
      var bk = db.bookings.find(function (x) { return x.oppId === body.opportunity_id; }) || db.bookings.find(function (x) { return DEPOSIT_FACILITIES[x.facilityKey] && x.status === 'Deposit Pending'; });
      if (bk) { bk.status = 'Confirmed'; bk.stage = 'Confirmed'; }
      db.payments.unshift({ id: uid('local-pay'), description: body.description || 'Booking deposit', amount: amt, currency: 'SGD', category: 'Deposit', status: 'paid', reference: 'DEP-' + String(body.opportunity_id || uid('')).slice(-6).toUpperCase(), opportunity_id: body.opportunity_id || '', fee_label: body.fee_label || '', resident_unit: body.unit || MEMBER.unit, resident_email: (body.email || MEMBER.email), paid_at: nowISO(), due_at: null, createdAt: nowISO() });
      persist();
      return ok({ message: 'Deposit paid - your booking is now confirmed.', amount: amt, stage: 'Confirmed' });
    }
    if (p === '/api/payments/confirm' && method === 'POST') return ok({ message: 'Booking confirmed.' });

    // RESIDENT SUBMISSIONS + "mine" lists
    if (p === '/api/guest' && method === 'POST') {
      var gref = guestRef(body.visit_date);
      db.guests.unshift({ oppId: uid('local-opp'), contactId: body.host_contact_id || MEMBER.contact_id, reference: gref, visitor: body.visitor_name, visitorEmail: body.visitor_email, visitorPhone: body.visitor_phone || '', visitorType: body.visitor_type, host: body.host_name || MEMBER.name, unit: body.host_unit || MEMBER.unit, phone: body.visitor_phone || '', visitDate: body.visit_date, duration: body.duration || 'Single Visit (Day)', stage: 'Registered', createdAt: nowISO() });
      persist();
      return ok({ message: 'Visitor registered.', reference: gref });
    }
    if (p === '/api/defect' && method === 'POST') {
      db.defects.unshift({ id: uid('local-defect'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, desc: body.description, category: body.category || 'General', location: body.location || '', urgency: body.urgency || 'Medium', stage: 'Reported', contact: MEMBER.name, unit: MEMBER.unit, ts: nowISO() });
      persist();
      return ok({ message: 'Defect report submitted.' });
    }
    if (p === '/api/feedback' && method === 'POST') {
      var fref = 'FB-' + Date.now().toString().slice(-8);
      db.feedback.unshift({ id: uid('local-fb'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, type: body.type || 'Feedback', category: body.category || 'General', desc: body.description, incident_date: body.incident_date || '', incident_time: body.incident_time || '', stage: 'Submitted', contact: MEMBER.name, unit: MEMBER.unit, ts: nowISO() });
      persist();
      return ok({ message: 'Submission received.', reference: fref });
    }
    if (p === '/api/move' && method === 'POST') {
      db.moves.unshift({ id: uid('local-move'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, move_type: body.move_type, move_date: body.move_date, move_time: body.move_time, notes: body.notes || '', stage: 'Deposit Pending', contact: body.name || MEMBER.name, unit: body.unit || MEMBER.unit, ts: nowISO() });
      persist();
      return ok({ message: 'Move booking submitted. Management will confirm within 2 working days.' });
    }
    if (p === '/api/parcel' && method === 'POST') {
      var pref = body.parcel_reference;
      var dup = db.parcels.find(function (x) { return x.ref.toLowerCase() === String(pref).toLowerCase(); });
      if (dup) return ok({ message: 'This parcel is already logged with the guardhouse.', reference: pref, duplicate: true });
      db.parcels.unshift({ id: uid('local-parcel'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, ref: pref, courier: body.courier || '', desc: body.description || '', collector: body.authorized_collector || '', resident: body.resident_name || MEMBER.name, unit: body.resident_unit || MEMBER.unit, stage: 'Received', ts: nowISO() });
      persist();
      return ok({ message: 'Guardhouse notified.', reference: pref });
    }
    if (p === '/api/defect/mine')   return ok({ items: db.defects.map(function (x) { return { desc: x.desc, category: x.category, location: x.location, urgency: x.urgency, ts: x.ts }; }) });
    if (p === '/api/feedback/mine') return ok({ items: db.feedback.map(function (x) { return { type: x.type, category: x.category, desc: x.desc, incident_date: x.incident_date, incident_time: x.incident_time, ts: x.ts }; }) });
    if (p === '/api/move/mine')     return ok({ items: db.moves.map(function (x) { return { move_type: x.move_type, move_date: x.move_date, move_time: x.move_time, notes: x.notes, ts: x.ts }; }) });
    if (p === '/api/parcel/mine')   return ok({ items: db.parcels.map(function (x) { return { ref: x.ref, courier: x.courier, desc: x.desc, collector: x.collector, ts: x.ts }; }) });

    // RESOURCES (resident)
    if (p === '/api/resources') return ok({ resources: db.resources.map(stripFile) });
    if ((m = p.match(/^\/api\/resources\/([^/]+)\/download$/)) && method === 'GET') {
      var rr = db.resources.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      return rr ? ok({ file_data: rr.file_data, file_name: rr.file_name, file_type: rr.file_type }) : J({ success: false, message: 'Not found.' }, 404);
    }

    // GUARDHOUSE
    if (p === '/api/guardhouse/lookup') {
      var ref = (qs.get('reference') || qs.get('ref') || '').trim();
      var g = db.guests.find(function (x) { return x.reference === ref; });
      if (!g) return ok({ found: false });
      return ok({ found: true, reference: g.reference, visitor: g.visitor, hostUnit: g.unit, hostContactId: g.contactId, opportunityId: g.oppId, visitDate: g.visitDate, stage: g.stage, status: 'open' });
    }
    if (p === '/api/guardhouse/checkin' && method === 'POST') {
      var actMap = { checkin: 'Checked In', checkout: 'Checked Out', depart: 'Departed' };
      var g2 = db.guests.find(function (x) { return x.contactId === body.contact_id; });
      if (g2) { g2.stage = actMap[body.action] || 'Checked In'; persist(); }
      return ok({ tag: 'guest-' + (body.action || 'checked-in') });
    }
    if (p === '/api/guardhouse/parcel' && method === 'GET') {
      var pref2 = (qs.get('reference') || qs.get('ref') || '').trim();
      var pc = db.parcels.find(function (x) { return x.ref.toLowerCase() === pref2.toLowerCase(); });
      if (!pc) return ok({ found: false });
      return ok({ found: true, reference: pc.ref, opportunityId: pc.opportunityId, resident: pc.resident, unit: pc.unit, stage: pc.stage, authorizedCollector: pc.collector });
    }
    if (p === '/api/guardhouse/parcel/status' && method === 'POST') {
      var stMap = { received: 'Notified', hold: 'Notified', collected: 'Collected', uncollected: 'Uncollected / Returned' };
      var pc2 = db.parcels.find(function (x) { return (body.opportunity_id && x.opportunityId === body.opportunity_id) || (body.reference && x.ref.toLowerCase() === String(body.reference).toLowerCase()); });
      if (pc2) { pc2.stage = stMap[body.status] || pc2.stage; persist(); }
      return ok({ tag: 'parcel-' + (body.status || 'notified') });
    }
    if (p === '/api/guardhouse/log' && method === 'GET') {
      return ok({ entries: db.guardLog.map(fmtLog) });
    }
    if (p === '/api/guardhouse/log' && method === 'POST') {
      var e = { _id: uid('log'), cat: body.cat || 'guest', key: body.key || '', type: body.type || '', label: body.label || '', name: body.name || '', meta: body.meta || '', updatedAt: nowISO() };
      if (body.key) { var ex = db.guardLog.find(function (x) { return x.key === body.key; }); if (ex) { Object.assign(ex, e, { _id: ex._id }); } else { db.guardLog.unshift(e); } }
      else db.guardLog.unshift(e);
      persist();
      return ok();
    }
    if (p === '/api/guardhouse/log' && method === 'DELETE') {
      var scope = qs.get('scope');
      db.guardLog = db.guardLog.filter(function (x) { return scope === 'parcel' ? x.cat !== 'parcel' : x.cat === 'parcel'; });
      persist();
      return ok();
    }

    // MANAGEMENT
    if (p === '/api/management/contacts/search') {
      var q = (qs.get('q') || '').toLowerCase();
      var contacts = db.residents.filter(function (r) { return (r.name + r.email + r.unit).toLowerCase().indexOf(q) !== -1; })
        .map(function (r) { return { id: r.contact_id, name: r.name, email: r.email, unit: r.unit }; });
      return ok({ contacts: contacts });
    }
    if (p === '/api/management/guest' && method === 'POST') {
      var gref2 = guestRef(body.visit_date);
      var host = db.residents.find(function (r) { return r.contact_id === body.host_contact_id || r.email === body.host_email; }) || MEMBER;
      db.guests.unshift({ oppId: uid('local-opp'), contactId: host.contact_id, reference: gref2, visitor: body.visitor_name, visitorEmail: body.visitor_email || '', visitorPhone: body.visitor_phone || '', visitorType: body.visitor_type || 'Guest', host: host.name, unit: host.unit, phone: body.visitor_phone || '', visitDate: body.visit_date, duration: body.duration || 'Single Visit (Day)', stage: 'Registered', createdAt: nowISO() });
      persist();
      var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=' + encodeURIComponent(gref2);
      return ok({ message: 'Visitor registered.', reference: gref2, qr_url: qrUrl });
    }
    if (p === '/api/management/guests' && method === 'GET') {
      var gi = db.guests.map(function (g) { return { oppId: g.oppId, contactId: g.contactId, reference: g.reference, visitor: g.visitor, host: g.host, unit: g.unit, phone: g.phone, visitDate: g.visitDate, stage: g.stage, createdAt: g.createdAt }; });
      return ok({ items: gi, total: gi.length, stages: STAGES.guest });
    }
    if ((m = p.match(/^\/api\/management\/guests\/([^/]+)\/stage$/)) && method === 'PUT') {
      setStageById(db.guests, decodeURIComponent(m[1]), body.stage);
      return ok({ message: 'Guest moved to ' + body.stage + '.', stage: body.stage });
    }
    if (p === '/api/management/opportunities' && method === 'GET') {
      var pk = qs.get('pipeline');
      var list = collectionFor(pk).map(function (it) {
        return { oppId: it.oppId || it.opportunityId || it.id, contactId: it.contactId, reference: it.reference || it.ref || '', contact: it.contact || it.resident || it.host || '', unit: it.unit, stage: it.stage, urgency: it.urgency || '', createdAt: it.ts || it.createdAt || nowISO() };
      });
      return ok({ items: list, total: list.length, stages: STAGES[pk] || [] });
    }
    if ((m = p.match(/^\/api\/management\/opportunities\/([^/]+)\/stage$/)) && method === 'PUT') {
      setStageById(collectionFor(body.pipeline), decodeURIComponent(m[1]), body.stage);
      return ok({ message: 'Moved to ' + body.stage + '.', stage: body.stage });
    }
    if (p === '/api/management/residents') return ok({ residents: db.residents.map(function (r) { return { name: r.name, unit: r.unit, email: r.email, phone: r.phone, type: r.type, ghlLinked: r.ghlLinked }; }), total: db.residents.length });
    if (p === '/api/management/bookings' && method === 'GET') return ok({ items: db.bookings, total: db.bookings.length, stages: STAGES.facility });
    if ((m = p.match(/^\/api\/management\/bookings\/([^/]+)\/stage$/)) && method === 'PUT') {
      var bId = decodeURIComponent(m[1]);
      var bk2 = db.bookings.find(function (x) { return x.oppId === bId || x.id === bId; });
      if (bk2) { bk2.status = body.stage; bk2.stage = body.stage; persist(); }
      return ok({ message: 'Booking moved to ' + body.stage + '.', stage: body.stage });
    }
    if (p === '/api/management/payments') return ok({ payments: db.payments });

    if (p === '/api/management/announcements' && method === 'GET') return ok({ announcements: db.announcements });
    if (p === '/api/management/announcements' && method === 'POST') {
      var a = { id: uid('local-ann'), title: body.title, body: body.body, category: body.category || 'General', eventAt: body.eventAt || null, eventEndAt: body.eventEndAt || null, pinned: !!body.pinned, rsvp_enabled: !!body.rsvp_enabled, blocked_facilities: body.blocked_facilities || [], event_venue: body.event_venue || '', createdAt: nowISO() };
      db.announcements.unshift(a); persist();
      return ok({ announcement: a });
    }
    if ((m = p.match(/^\/api\/management\/announcements\/([^/]+)$/)) && method === 'DELETE') {
      db.announcements = db.announcements.filter(function (x) { return x.id !== decodeURIComponent(m[1]); }); persist();
      return ok();
    }
    if ((m = p.match(/^\/api\/management\/announcements\/([^/]+)$/)) && method === 'PATCH') {
      var a2 = db.announcements.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      if (a2) { a2.pinned = !!body.pinned; persist(); }
      return ok({ announcement: a2 });
    }
    if ((m = p.match(/^\/api\/management\/rsvp\/([^/]+)$/)) && method === 'GET') {
      var aId2 = decodeURIComponent(m[1]);
      var resp = db.rsvps[aId2] ? Object.keys(db.rsvps[aId2]).map(function (k) { var v = db.rsvps[aId2][k]; return { resident_name: v.resident_name, resident_unit: v.resident_unit, response: v.response, attendee_count: v.attendee_count, updatedAt: v.updatedAt }; }) : [];
      var attending = resp.filter(function (r) { return r.response === 'yes'; });
      var declined = resp.filter(function (r) { return r.response === 'no'; });
      var attTotal = attending.reduce(function (s, r) { return s + (r.attendee_count || 1); }, 0);
      return ok({ total_responses: resp.length, attending_count: attending.length, attending_total: attTotal, declined_count: declined.length, responses: resp });
    }

    if (p === '/api/management/messages' && method === 'GET') {
      var total_unread = db.conversations.reduce(function (s, c) { return s + (c.unread_management || 0); }, 0);
      return ok({ conversations: db.conversations.map(convoMeta), total_unread: total_unread });
    }
    if (p === '/api/management/messages-residents') return ok({ residents: db.residents.map(function (r) { return { name: r.name, unit: r.unit, email: r.email, contact_id: r.contact_id }; }) });
    if ((m = p.match(/^\/api\/management\/messages\/([^/]+)$/)) && method === 'GET') {
      var c2 = db.conversations.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      if (c2) { c2.unread_management = 0; persist(); }
      return c2 ? ok({ conversation: convoMeta(c2), messages: c2.messages }) : J({ success: false, message: 'Not found.' }, 404);
    }
    if ((m = p.match(/^\/api\/management\/messages\/([^/]+)\/reply$/)) && method === 'POST') {
      var c3 = db.conversations.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      var rmsg = { id: uid('local-msg'), sender: 'management', sender_name: 'Management', body: body.body, createdAt: nowISO() };
      if (c3) { c3.messages.push(rmsg); c3.last_message_at = rmsg.createdAt; c3.last_message_preview = body.body.slice(0, 80); c3.last_sender = 'management'; c3.unread_resident += 1; persist(); }
      return ok({ message: rmsg });
    }
    if ((m = p.match(/^\/api\/management\/messages\/([^/]+)\/resolve$/)) && method === 'POST') {
      var c4 = db.conversations.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      if (c4) { c4.resolved = body.resolved != null ? !!body.resolved : true; persist(); }
      return ok({ conversation: c4 ? convoMeta(c4) : null });
    }
    if (p === '/api/management/messages/start' && method === 'POST') {
      var host2 = db.residents.find(function (r) { return r.contact_id === body.contact_id || r.email === body.resident_email; }) || db.residents[0];
      var nc = { id: uid('local-convo'), contact_id: host2.contact_id, resident_name: host2.name, resident_unit: host2.unit, resident_email: host2.email, unread_management: 0, unread_resident: 1, resolved: false, messages: [{ id: uid('local-msg'), sender: 'management', sender_name: 'Management', body: body.body, createdAt: nowISO() }] };
      nc.last_message_at = nc.messages[0].createdAt; nc.last_message_preview = body.body.slice(0, 80); nc.last_sender = 'management';
      db.conversations.unshift(nc); persist();
      return ok({ message: nc.messages[0], conversation_id: nc.id });
    }
    if (p === '/api/management/resources' && method === 'GET') return ok({ resources: db.resources.map(stripFile) });
    if ((m = p.match(/^\/api\/management\/resources\/([^/]+)\/download$/)) && method === 'GET') {
      var mr = db.resources.find(function (x) { return x.id === decodeURIComponent(m[1]); });
      return mr ? ok({ file_data: mr.file_data, file_name: mr.file_name, file_type: mr.file_type }) : J({ success: false, message: 'Not found.' }, 404);
    }
    if (p === '/api/management/resources' && method === 'POST') {
      var nr = { id: uid('local-res'), title: body.title, category: body.category || 'General', visibility: body.visibility || 'residents', file_data: body.file_data || '', file_name: body.file_name || '', file_type: body.file_type || '', file_size: body.file_size || 0, uploaded_by: 'Management', createdAt: nowISO() };
      db.resources.unshift(nr); persist();
      return ok({ resource: stripFile(nr) });
    }
    if ((m = p.match(/^\/api\/management\/resources\/([^/]+)$/)) && method === 'DELETE') {
      db.resources = db.resources.filter(function (x) { return x.id !== decodeURIComponent(m[1]); }); persist();
      return ok();
    }

    // Fallback
    console.warn('[client-backend] unhandled route:', method, p);
    return J({ success: true, items: [], message: 'Not implemented.' }, 200);
  }

  function convoMeta(c) {
    return { id: c.id, contact_id: c.contact_id, resident_name: c.resident_name, resident_unit: c.resident_unit, resident_email: c.resident_email, last_message_at: c.last_message_at, last_message_preview: c.last_message_preview, last_sender: c.last_sender, unread_management: c.unread_management, unread_resident: c.unread_resident, resolved: c.resolved };
  }
  function stripFile(r) { return { id: r.id, title: r.title, category: r.category, visibility: r.visibility, file_name: r.file_name, file_type: r.file_type, file_size: r.file_size, uploaded_by: r.uploaded_by, createdAt: r.createdAt }; }
  function fmtLog(e) {
    return { id: String(e._id), cat: e.cat, key: e.key, type: e.type, label: e.label, name: e.name, meta: e.meta, time: new Date(e.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) };
  }

  // fetch override — resident signup/login, management/guardhouse login,
  // logout, and the resources library (both resident and management sides)
  // are all real (Mongo-backed, via the reference backend deployed on
  // Railway), so those paths pass through untouched (logout MUST reach the
  // real network - it's what actually clears the httpOnly session cookie
  // server-side; the mock can't do that). Everything else stays mocked: those
  // other resident/management/guardhouse data views were built against a real
  // CRM (GoHighLevel) that isn't configured here, so they'd just 503 against
  // the real backend — the mock keeps them working.
  var _real = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;
  window.fetch = function (url, opts) {
    opts = opts || {};
    try {
      var s = (typeof url === 'string') ? url : (url && url.url) || '';
      var isRealPath = s.indexOf('/api/auth/resident/') !== -1
        || s.indexOf('/api/auth/management/login') !== -1
        || s.indexOf('/api/auth/guardhouse/login') !== -1
        || s.indexOf('/api/auth/logout') !== -1
        || s.indexOf('/api/resources') !== -1
        || s.indexOf('/api/management/resources') !== -1;
      if (s.indexOf('/api/') !== -1 && !isRealPath) {
        return Promise.resolve(handle(s, opts));
      }
    } catch (e) {
      console.error('[client-backend] error handling', url, e);
      return Promise.resolve(J({ success: false, message: 'Mock error.' }, 500));
    }
    return _real ? _real(url, opts) : Promise.reject(new Error('fetch unavailable'));
  };

  console.log('%c[The Lumina] Auth + resources are live (Mongo-backed); other views run on a local mock.', 'color:#312e81;font-weight:bold');
})();
