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

  // Each role has its own real login (and its own session cookie name), so only
  // establish the real background session for the portal page actually being viewed.
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

  // Stage vocabularies (mirror config/pipelines.js). Move-In/Out is a real
  // backend now (move.controller.js) - not handled by this mock at all anymore.
  var STAGES = {
    facility: ['Deposit Pending', 'Confirmed', 'Completed', 'No-Show', 'Cancelled'],
    guest:    ['Registered', 'Checked In', 'Checked Out', 'Departed', 'Closed'],
    parcel:   ['Received', 'Notified', 'Collected', 'Uncollected / Returned'],
    defect:   ['Reported', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'],
    feedback: ['Submitted', 'Under Review', 'Resolved', 'Closed'],
  };
  var PIPELINE_IDS = {
    facility: 'local-pipeline-facility', guest: 'local-pipeline-guest', parcel: 'local-pipeline-parcel',
    defect: 'local-pipeline-defect', feedback: 'local-pipeline-feedback',
  };

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
  function defectRef() { return 'DFT-' + Math.floor(1000 + Math.random() * 9000); }

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
      guests: [
        guest('Jane Lim',   'jane.lim@example.com',   '+65 9800 1122', 'Family & Friends', daysFromNow(1), 'Registered',  me),
        guest('David Wong', 'david.wong@example.com', '+65 9800 3344', 'Contractor',       daysFromNow(0), 'Checked In',  me),
      ],
      parcels: [
        parcel('SF-88213004', 'SingPost', 'Small box', '', 'Notified', me),
        parcel('LZ-40021199', 'Ninja Van', 'Documents envelope', 'Priya Nair', 'Received', me),
      ],
      defects: [
        defect('Leaking tap in master bathroom', 'Plumbing', '#12-08 Master Bath', 'Urgent', 'Acknowledged', me),
        defect('Corridor light flickering on level 12', 'Electrical', 'Level 12 lift lobby', 'Routine', 'In Progress', me),
      ],
      feedback: [
        feedback('Complaint', 'Noise', 'Renovation noise past permitted hours on level 11.', daysFromNow(-3), '21:30', 'Under Review', me),
        feedback('Suggestion', 'Community Events', 'Please organise a weekend farmers market at the verandah.', '', '', 'Submitted', me),
      ],
      rsvps: {},               // { [annId]: { [contactId]: {response, attendee_count, resident_name, resident_unit, updatedAt} } }
      conversations: [
        convo(me, [
          { sender: 'resident',   sender_name: 'Alex Tan',   body: 'Hi, could you confirm the visitor parking rules for weekends?', minsAgo: 180 },
          { sender: 'management', sender_name: 'Management', body: 'Hello Alex - weekend visitor parking is free up to 4 hours at lots V1 - V8. Just register the vehicle at the guardhouse.', minsAgo: 120 },
        ], false),
      ],
      guardLog: [],
    };
    return d;

    function guest(visitor, email, phone, type, date, stage, m) {
      return { oppId: uid('local-opp'), contactId: m.contact_id, reference: guestRef(date), visitor: visitor, visitorEmail: email, visitorPhone: phone, visitorType: type, host: m.name, unit: m.unit, phone: phone, visitDate: date, duration: 'Single Visit (Day)', stage: stage, createdAt: nowISO() };
    }
    function parcel(ref, courier, desc, collector, stage, m) {
      return { id: uid('local-parcel'), opportunityId: uid('local-opp'), contactId: m.contact_id, ref: ref, courier: courier, desc: desc, collector: collector, resident: m.name, unit: m.unit, stage: stage, ts: nowISO() };
    }
    function defect(desc, category, location, urgency, stage, m) {
      return { id: uid('local-defect'), opportunityId: uid('local-opp'), contactId: m.contact_id, reference: defectRef(), desc: desc, category: category, secondaryCategory: '', location: location, urgency: urgency, photo: '', stage: stage, contact: m.name, unit: m.unit, ts: nowISO() };
    }
    function feedback(type, category, desc, idate, itime, stage, m) {
      return { id: uid('local-fb'), opportunityId: uid('local-opp'), contactId: m.contact_id, type: type, category: category, desc: desc, incident_date: idate, incident_time: itime, stage: stage, contact: m.name, unit: m.unit, ts: nowISO() };
    }
    function convo(m, msgs, resolved) {
      var messages = msgs.map(function (x) {
        return { id: uid('local-msg'), sender: x.sender, sender_name: x.sender_name, body: x.body, createdAt: new Date(Date.now() - x.minsAgo * 60000).toISOString() };
      });
      var last = messages[messages.length - 1];
      return { id: uid('local-convo'), contact_id: m.contact_id, resident_name: m.name, resident_unit: m.unit, resident_email: m.email, last_message_at: last.createdAt, last_message_preview: last.body.slice(0, 80), last_sender: last.sender, unread_management: 0, unread_resident: 0, resolved: !!resolved, messages: messages };
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
    if (kind === 'guest')   return it.reference + ' - ' + it.visitor + ' (#' + it.unit + ')';
    if (kind === 'parcel')  return it.ref + ' - ' + it.resident + ' (#' + it.unit + ')' + (it.collector ? ' [Auth: ' + it.collector + ']' : '');
    if (kind === 'defect')  return (it.category ? it.category + ': ' : '') + it.desc;
    if (kind === 'feedback')return (it.type ? it.type + ' - ' : '') + it.desc;
    if (kind === 'move')    return it.move_type + ' - ' + it.contact + ' (#' + it.unit + ') · ' + it.move_date + ' ' + it.move_time;
    return it.desc || it.name || '';
  }
  function toOpp(kind, it) {
    return { id: it.oppId || it.opportunityId || it.id, name: oppName(kind, it), stage: it.stage, pipelineId: PIPELINE_IDS[kind], createdAt: it.ts || it.createdAt || nowISO(), customFields: [] };
  }
  function collectionFor(kind) {
    return { guest: db.guests, parcel: db.parcels, defect: db.defects, feedback: db.feedback }[kind] || [];
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

    // OPPORTUNITIES (resident "My …")
    if (p === '/api/opportunities') {
      var kind = qs.get('pipeline') || 'guest';
      var items = collectionFor(kind).map(function (it) { return toOpp(kind, it); });
      return ok({ items: items, total: items.length });
    }

    // RSVP is real now (rsvp.controller.js, in isRealPath) — the branches below
    // are dead. MESSAGES (resident) are still mocked; announcements are real.
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

    // RESIDENT SUBMISSIONS + "mine" lists
    // Guest registration/lookup (/api/guest, /api/guardhouse/lookup+checkin,
    // /api/management/guest(s), /api/management/contacts/search) is now real -
    // see isRealPath below - so those mock branches are gone from here.
    if (p === '/api/defect' && method === 'POST') {
      // Keep the attached photo only if it fits a sane budget — base64 images
      // live in localStorage (~5MB cap shared across the whole demo), so an
      // oversized upload is dropped rather than blowing the quota. Photos are
      // already downscaled + JPEG-compressed client-side before they reach here.
      var photo = (typeof body.defect_file === 'string' && body.defect_file.length < 1500000) ? body.defect_file : '';
      var dref  = defectRef();
      db.defects.unshift({ id: uid('local-defect'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, reference: dref, desc: body.description, category: body.category || 'General', secondaryCategory: body.secondaryCategory || '', location: body.location || '', urgency: body.urgency || 'Routine', photo: photo, stage: 'Reported', contact: MEMBER.name, unit: MEMBER.unit, ts: nowISO() });
      if (db.defects.length > 40) db.defects.length = 40; // bound localStorage growth
      persist();
      return ok({ message: 'Defect report submitted.', reference: dref });
    }
    if (p === '/api/feedback' && method === 'POST') {
      var fref = 'FB-' + Date.now().toString().slice(-8);
      db.feedback.unshift({ id: uid('local-fb'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, type: body.type || 'Feedback', category: body.category || 'General', desc: body.description, incident_date: body.incident_date || '', incident_time: body.incident_time || '', stage: 'Submitted', contact: MEMBER.name, unit: MEMBER.unit, ts: nowISO() });
      persist();
      return ok({ message: 'Submission received.', reference: fref });
    }
    if (p === '/api/parcel' && method === 'POST') {
      var pref = body.parcel_reference;
      var dup = db.parcels.find(function (x) { return x.ref.toLowerCase() === String(pref).toLowerCase(); });
      if (dup) return ok({ message: 'This parcel is already logged with the guardhouse.', reference: pref, duplicate: true });
      db.parcels.unshift({ id: uid('local-parcel'), opportunityId: uid('local-opp'), contactId: MEMBER.contact_id, ref: pref, courier: body.courier || '', desc: body.description || '', collector: body.authorized_collector || '', resident: body.resident_name || MEMBER.name, unit: body.resident_unit || MEMBER.unit, stage: 'Received', ts: nowISO() });
      persist();
      return ok({ message: 'Guardhouse notified.', reference: pref });
    }
    if (p === '/api/defect/mine')   return ok({ items: db.defects.map(function (x) { return { reference: x.reference || '', desc: x.desc, category: x.category, secondaryCategory: x.secondaryCategory || '', location: x.location, urgency: x.urgency, photo: x.photo || '', ts: x.ts }; }) });
    if (p === '/api/feedback/mine') return ok({ items: db.feedback.map(function (x) { return { type: x.type, category: x.category, desc: x.desc, incident_date: x.incident_date, incident_time: x.incident_time, ts: x.ts }; }) });
    if (p === '/api/parcel/mine')   return ok({ items: db.parcels.map(function (x) { return { ref: x.ref, courier: x.courier, desc: x.desc, collector: x.collector, ts: x.ts }; }) });

    // GUARDHOUSE - lookup/checkin are real now (see isRealPath); parcel + the
    // shared activity log below are still mocked.
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

    // MANAGEMENT - guest desk (contacts/search, guest, guests, guests/:id/stage)
    // is real now (see isRealPath); the generic opportunities pipeline below
    // still covers defect/parcel/feedback.
    if (p === '/api/management/opportunities' && method === 'GET') {
      var pk = qs.get('pipeline');
      var list = collectionFor(pk).map(function (it) {
        // Defects have no natural "reference" like a parcel/guest pass, so pack
        // the tracking code + the actual reported issue into the reference cell
        // — otherwise the management table shows a blank first column and the
        // triager can't tell what's broken (and search-by-text finds nothing).
        var ref = it.reference || it.ref || '';
        if (pk === 'defect') {
          var cat = it.secondaryCategory ? it.category + ' + ' + it.secondaryCategory : it.category;
          ref = (it.reference ? it.reference + ' · ' : '') + (cat ? cat + ': ' : '') + (it.desc || '');
        }
        return { oppId: it.oppId || it.opportunityId || it.id, contactId: it.contactId, reference: ref, contact: it.contact || it.resident || it.host || '', unit: it.unit, stage: it.stage, urgency: it.urgency || '', photo: it.photo || '', location: it.location || '', createdAt: it.ts || it.createdAt || nowISO() };
      });
      return ok({ items: list, total: list.length, stages: STAGES[pk] || [] });
    }
    if ((m = p.match(/^\/api\/management\/opportunities\/([^/]+)\/stage$/)) && method === 'PUT') {
      setStageById(collectionFor(body.pipeline), decodeURIComponent(m[1]), body.stage);
      return ok({ message: 'Moved to ' + body.stage + '.', stage: body.stage });
    }
    if (p === '/api/management/residents') return ok({ residents: db.residents.map(function (r) { return { name: r.name, unit: r.unit, email: r.email, phone: r.phone, type: r.type, ghlLinked: r.ghlLinked }; }), total: db.residents.length });

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
    // Fallback
    console.warn('[client-backend] unhandled route:', method, p);
    return J({ success: true, items: [], message: 'Not implemented.' }, 200);
  }

  function convoMeta(c) {
    return { id: c.id, contact_id: c.contact_id, resident_name: c.resident_name, resident_unit: c.resident_unit, resident_email: c.resident_email, last_message_at: c.last_message_at, last_message_preview: c.last_message_preview, last_sender: c.last_sender, unread_management: c.unread_management, unread_resident: c.unread_resident, resolved: c.resolved };
  }
  function fmtLog(e) {
    return { id: String(e._id), cat: e.cat, key: e.key, type: e.type, label: e.label, name: e.name, meta: e.meta, time: new Date(e.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) };
  }

  // fetch override — resident signup/login, management/guardhouse login,
  // logout, the resources library, announcements, facility bookings,
  // Move-In/Out (both resident and management sides of each), and guest
  // passes (resident + management registration/listing, and the guardhouse's
  // lookup/check-in) are all real (Mongo-backed, via the reference backend
  // deployed on Railway), so those paths pass through untouched (logout MUST
  // reach the real network - it's what actually clears the httpOnly session
  // cookie server-side; the mock can't do that).
  // Everything else stays mocked: parcels, feedback, messages, and the
  // guardhouse's shared activity log were built against a real CRM
  // (GoHighLevel) that isn't configured here, so they'd just 503 against the
  // real backend — the mock keeps them working. (Defects are now real too — see
  // /api/defect above — so the defect branches in this router are dead code
  // kept only as a reference for how the others could be migrated.)
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
        || s.indexOf('/api/management/resources') !== -1
        || s.indexOf('/api/announcements') !== -1
        || s.indexOf('/api/management/announcements') !== -1
        || s.indexOf('/api/booking') !== -1
        || s.indexOf('/api/management/bookings') !== -1
        || s.indexOf('/api/move') !== -1
        || s.indexOf('/api/management/moves') !== -1
        || s.indexOf('/api/defect') !== -1
        || s.indexOf('/api/management/defects') !== -1
        || s.indexOf('/api/rsvp') !== -1
        || s.indexOf('/api/management/rsvp') !== -1
        || s.indexOf('/api/guest') !== -1
        || s.indexOf('/api/management/guest') !== -1
        || s.indexOf('/api/management/contacts/search') !== -1
        || s.indexOf('/api/management/audit') !== -1
        || s.indexOf('/api/guardhouse/lookup') !== -1
        || s.indexOf('/api/guardhouse/checkin') !== -1;
      if (s.indexOf('/api/') !== -1 && !isRealPath) {
        return Promise.resolve(handle(s, opts));
      }
    } catch (e) {
      console.error('[client-backend] error handling', url, e);
      return Promise.resolve(J({ success: false, message: 'Mock error.' }, 500));
    }
    return _real ? _real(url, opts) : Promise.reject(new Error('fetch unavailable'));
  };

  console.log('%c[The Lumina] Auth, resources, announcements, facility booking, Move-In/Out, guest passes, and defect reports are live (Mongo-backed); parcels/feedback still run on a local mock.', 'color:#312e81;font-weight:bold');
})();
