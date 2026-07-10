(function () {
  'use strict';

  // portal.controller.js  (served at /js/portal.controller.js)
  // Client-side controller for portal.html.
  // Login authenticates against POST /api/auth/resident/login. Facility bookings
  // are stored locally (browser) so the UI is fully usable; they'll be sent to
  // GHL once the booking API is reconnected.

  const SESS = 'meridian_member';
  const TOKEN_KEY = 'meridian_token';
  const BK   = 'meridian_bookings';
  const $ = id => document.getElementById(id);
  // Finished bookings (no longer active): shown in history but excluded from the
  // active count, per-day limit, slot re-booking guard and guest linking.
  const FINISHED_STATUSES = ['Completed', 'No-Show', 'Cancelled'];
  const isFinished = s => FINISHED_STATUSES.includes(s);

  // ── Authenticated fetch ────────────────────────────────────────────────────
  // The resident session token (set on login) is attached to every same-origin
  // /api/ call. The backend derives identity from this token - the portal no longer
  // proves who it is by sending contact_id/email in the request. Shadows the global
  // fetch so every existing call site is covered without change.
  let authToken = null;
  const _rawFetch = window.fetch.bind(window);
  function fetch(url, opts = {}) {
    if (authToken && typeof url === 'string' && url.startsWith('/api/')) {
      opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + authToken } };
    }
    return _rawFetch(url, opts).then(res => {
      // A 401 on a non-login API call means the session is gone/expired - bounce to login.
      if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/auth/')) {
        handleAuthExpired();
      }
      return res;
    });
  }

  let _authExpiredHandled = false;
  function handleAuthExpired() {
    if (_authExpiredHandled) return;     // avoid a storm of reloads from parallel calls
    _authExpiredHandled = true;
    authToken = null;
    [SESS, TOKEN_KEY, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    window.location.reload();
  }

  // ── Theme toggle ─────────────────────────────────────────────────────────────
  (function initTheme() {
    const KEY = 'meridian-portal-theme';
    function syncToggleUI(theme) {
      document.querySelectorAll('[data-theme-toggle]').forEach(el => {
        el.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
      });
    }
    syncToggleUI(document.documentElement.dataset.theme || 'light');
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem(KEY, next);
        syncToggleUI(next);
      });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (!localStorage.getItem(KEY)) {
        const t = e.matches ? 'dark' : 'light';
        document.documentElement.dataset.theme = t;
        syncToggleUI(t);
      }
    });
  })();

  // ── Facility catalogue ───────────────────────────────────────────────────────
  const FACILITIES = [
    { key: 'pool',       name: 'Swimming Pool',    emoji: '🏊', deposit: true, open: 7,  close: 23, slot: 1, maxPax: 5,  capacity: 'Max 4 guests / unit',  note: 'Children under 12 must be accompanied by an adult resident.',  notePlaceholder: 'e.g. Bringing 2 young children, all are supervised adults present' },
    { key: 'tennis',     name: 'Tennis Court',     emoji: '🎾', open: 7,  close: 23, slot: 1, maxPax: 4,  capacity: 'Max 3 guests',          note: 'Proper non-marking footwear required on court.',               notePlaceholder: 'e.g. Singles match, bringing own rackets and balls' },
    { key: 'squash',     name: 'Squash Court',     emoji: '🥎', open: 7,  close: 23, slot: 1, maxPax: 4,  capacity: 'Max 3 guests',          note: 'Non-marking shoes only. Eyewear recommended.',                 notePlaceholder: 'e.g. Friendly doubles game, please check front wall marker condition' },
    { key: 'basketball', name: 'Basketball Court', emoji: '🏀', open: 8,  close: 23, slot: 1, maxPax: 12, capacity: 'Max 12 occupants',       note: 'Half-court sharing may apply at peak hours.',                  notePlaceholder: 'e.g. 5-on-5 full court game, need ball pump available at guardhouse' },
    { key: 'gym',        name: 'Gymnasium',        emoji: '🏋️', open: 6,  close: 23, slot: 1, maxPax: 1,  capacity: 'Residents only',        note: 'No guests. Minimum age 16. Wipe down equipment after use.',    notePlaceholder: 'e.g. Need squat rack and bench press available, please check cable machine condition' },
    { key: 'fitness',    name: 'Fitness Room',     emoji: '🤸', open: 6,  close: 23, slot: 1, maxPax: 1,  capacity: 'Residents only',        note: 'Studio / yoga space. No guests permitted.',                    notePlaceholder: 'e.g. Yoga session, please have mats and blocks set out in advance' },
    { key: 'bbq',        name: 'BBQ Pit',          emoji: '🔥', deposit: true, open: 10, close: 23, slot: 3, maxPax: 15, capacity: 'Up to 15 pax',           note: 'Clean-up required after use. Charcoal provided.',              notePlaceholder: 'e.g. Birthday gathering for 12 pax, need extra charcoal and starter fluid' },
    { key: 'verandah',   name: 'The Verandah',     emoji: '🥂', deposit: true, open: 7,  close: 23, slot: 4, slotStep: 240, maxPax: 40, capacity: 'Event space · 40 pax', maxAdvanceDays: 31, maxBlocksPerDay: 2, note: 'Bookings are in 4-hour blocks. Max 2 blocks per day, up to 1 month in advance. Private functions only.', notePlaceholder: 'e.g. Private dinner for 20 pax, tables arranged in U-shape, need PA system' },
  ];
  const facByKey   = key => FACILITIES.find(f => f.key === key);
  const hoursLabel = f   => `${fmtHour(f.open)} - ${fmtHour(f.close)}`;
  function fmtHour(h) { const ap = h >= 12 ? 'pm' : 'am'; const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}${ap}`; }
  function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

  // Format total minutes into "9:15 AM" style.
  function fmtMins(totalMins) {
    const h  = Math.floor(totalMins / 60) % 24;
    const m  = totalMins % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
  }

  // Generate slots at 15-minute start intervals for the facility's slot duration.
  function timeSlots(f) {
    const out      = [];
    const slotMins = f.slot * 60;
    const closeMin = f.close * 60;
    for (let m = f.open * 60; m + slotMins <= closeMin; m += (f.slotStep || 15)) {
      out.push(`${fmtMins(m)} - ${fmtMins(m + slotMins)}`);
    }
    return out;
  }

  // Current SGT time in total minutes (used to gate past slots).
  function nowSGTMins() {
    const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  // Parse the START time of a slot string ("9:15 AM - 10:15 AM") → minutes.
  function parseSlotStart(slotStr) {
    const [time, ap] = slotStr.split(' - ')[0].trim().split(' ');
    const [h, m]     = time.split(':').map(Number);
    const hours = ap === 'PM' && h !== 12 ? h + 12 : ap === 'AM' && h === 12 ? 0 : h;
    return hours * 60 + m;
  }
  // Parse the END time of a slot string → minutes.
  function parseSlotEnd(slotStr) {
    const [time, ap] = slotStr.split(' - ')[1].trim().split(' ');
    const [h, m]     = time.split(':').map(Number);
    const hours = ap === 'PM' && h !== 12 ? h + 12 : ap === 'AM' && h === 12 ? 0 : h;
    return hours * 60 + m;
  }

  // Fetch already-booked ranges (SGT minutes) for a facility/date from the server.
  // GHL is the shared source of truth, so this reflects EVERY resident's bookings.
  // Fails open to [] - the server's createBooking guard is the authoritative block.
  async function fetchBusyRanges(facilityKey, date, excludeId) {
    try {
      let url = `/api/booking/availability?facilityKey=${encodeURIComponent(facilityKey)}&date=${encodeURIComponent(date)}`;
      if (excludeId) url += `&exclude=${encodeURIComponent(excludeId)}`;
      const res  = await fetch(url);
      const data = await res.json();
      return (data && data.busy) || [];
    } catch { return []; }
  }

  // Rebuild the slot dropdown for the selected date - disables past slots (today)
  // AND any slot overlapping an already-confirmed booking (from the server/GHL).
  async function refreshSlots(f) {
    const dateVal = $('bkDate') && $('bkDate').value;
    const select  = $('bkSlot');
    const hint    = $('bkSlotHint');
    if (!select) return;

    if (!dateVal) {
      select.innerHTML = `<option value="">select a date first</option>`;
      if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = ''; }
      return;
    }

    const slots   = timeSlots(f);
    const isToday  = dateVal === todaySGT();
    const nowMins  = isToday ? nowSGTMins() : -1;
    const prevVal  = select.value;

    // Loading state while availability is fetched.
    select.disabled  = true;
    select.innerHTML = `<option value="">checking availability…</option>`;
    if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = 'Checking availability…'; }

    const busy = await fetchBusyRanges(f.key, dateVal, _editing ? _editing.id : '');
    // Bail if the user changed the date while we were fetching (stale response).
    if (($('bkDate') && $('bkDate').value) !== dateVal) return;
    select.disabled = false;

    const overlaps = (start, end) => busy.some(b => start < b.end && end > b.start);

    let pastCount = 0, bookedCount = 0;
    const options = slots.map(s => {
      const start = parseSlotStart(s), end = parseSlotEnd(s);
      const past   = isToday && start <= nowMins;
      const booked = !past && overlaps(start, end);
      if (past)   pastCount++;
      if (booked) bookedCount++;
      const disabled = past || booked;
      const label    = booked ? `${s} - booked` : s;
      return `<option value="${esc(s)}" ${disabled ? 'disabled' : ''}>${esc(label)}</option>`;
    }).join('');

    select.innerHTML = `<option value="">choose a time slot</option>` + options;

    // Restore previous selection only if it's still bookable.
    if (prevVal) {
      const start = parseSlotStart(prevVal), end = parseSlotEnd(prevVal);
      const stillBad = (isToday && start <= nowMins) || overlaps(start, end);
      select.value = stillBad ? '' : prevVal;
    }

    if (!hint) return;
    const avail = slots.length - pastCount - bookedCount;
    if (avail === 0) {
      hint.className = 'bk-slot-hint err';
      hint.innerHTML = isToday
        ? '⚠ No slots available today - please select a future date.'
        : '⚠ Fully booked - please select another date.';
    } else {
      hint.className = 'bk-slot-hint';
      const parts = [`<span class="bk-hint-ok">✓ ${avail} available</span>`];
      if (bookedCount) parts.push(`<span class="bk-hint-past">${bookedCount} booked</span>`);
      if (pastCount)   parts.push(`<span class="bk-hint-past">${pastCount} past</span>`);
      hint.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    }
  }
  function todaySGT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }
  function fmtDate(iso) {
    if (!iso) return ' - ';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  // Bookings are persisted SERVER-SIDE in MongoDB (the source of truth) - never in the
  // browser, so they're consistent across devices and both portals. We keep an
  // in-memory cache hydrated from /api/booking/mine (see loadBookings); create/edit/
  // cancel hit the API (which writes Mongo) and then refresh this cache.
  const FAC_EMOJI = Object.fromEntries(FACILITIES.map(f => [f.key, f.emoji]));
  let _bookings = [];
  const getBookings  = () => _bookings;
  const saveBookings = list => { _bookings = Array.isArray(list) ? list : []; };  // optimistic; persistence is via the API
  // The full text a resident typed for defects/parcels/moves/feedback (GHL only keeps
  // a short opp name) is persisted in the live MongoDB on submit and read back here - // never in localStorage, so it's consistent across every device and both portals.
  // Returns newest-first rows in the shape renderRecords expects as `saved`.
  const fetchMine = async (type) => {
    if (!member || (!member.contact_id && !member.email)) return [];
    try {
      const r = await fetch(`/api/${type}/mine`);
      const d = await r.json();
      return (d && d.items) || [];
    } catch { return []; }
  };


  // ── Session / login ──────────────────────────────────────────────────────────
  let member = null;
  // NOTE: restoring the session and auto-booting is deferred to the very end of
  // this IIFE (see bottom). bootPortal() reads top-level consts declared further
  // down (e.g. FB_CATEGORIES); calling it here would hit a temporal-dead-zone
  // "Cannot access 'FB_CATEGORIES' before initialization" error for returning
  // sessions. Everything must be initialized first.

  $('loginBtn').addEventListener('click', doLogin);
  $('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('loginUnit').addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const unit  = $('loginUnit').value.trim();
    const email = $('loginEmail').value.trim().toLowerCase();
    const errEl = $('loginErr');
    const btn   = $('loginBtn');
    if (!unit || !email) { errEl.textContent = 'Please enter your unit number and email address.'; return; }
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const res  = await fetch('/api/auth/resident/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, unit }),
      });
      const data = await res.json();
      if (!data.success) { errEl.textContent = data.message || 'Details not found.'; return; }
      member = data.member;
      authToken = data.token || null;
      _authExpiredHandled = false;
      sessionStorage.setItem(SESS, JSON.stringify(member));
      localStorage.setItem(SESS, JSON.stringify(member));
      if (authToken) { sessionStorage.setItem(TOKEN_KEY, authToken); localStorage.setItem(TOKEN_KEY, authToken); }
      bootPortal();
    } catch {
      errEl.textContent = 'Connection error. Please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Access Resident Portal';
    }
  }

  function bootPortal() {
    $('login-screen').style.display = 'none';
    $('portal-shell').style.display = 'block';
    $('loadingOverlay').classList.add('hidden');

    $('sbAvatar').textContent = (member.initials || 'R').toUpperCase();
    $('sbName').textContent   = member.name || 'Resident';
    $('sbUnit').textContent   = `Unit ${member.unit || ' - '}`;
    const rType = (member.type || '').trim();
    $('sbBadge').textContent  = (rType === 'Owner' || rType === 'Tenant') ? `Resident (${rType})` : 'Resident';

    $('topbarDate').textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore',
    });

    const today = todaySGT();
    const gDateEl = $('gDate'); if (gDateEl) { gDateEl.min = today; gDateEl.value = today; }
    // fbDate intentionally has no min - incidents may have occurred in the past.

    renderFacilities(); renderMyBookings(); renderDashboardBookings();
    updateFbCategories();
    navigate(localStorage.getItem('portalLastView') || 'dashboard');
    syncBookingStatuses(); // pull live stages set by management
    loadNotices();         // pull announcements published by management
    loadMsgBadge();        // unread message count for the sidebar
    setInterval(loadMsgBadge, 30000); // keep the unread badge fresh
    // Live inbox: refresh the open Messages thread without a page reload.
    setInterval(() => { const v = $('view-messages'); if (v && v.classList.contains('active')) loadMessages(); }, 7000);
    // Live payments: refresh pending deposits while the panel is open so a new
    // booking's deposit appears once GHL creates its opportunity (a few seconds
    // after booking), without a manual reload.
    // Refresh only Pending Deposits on poll - re-rendering the history would collapse
    // any open record dropdown the resident is reading.
    setInterval(() => {
      const v = $('view-payments');
      // Never refresh while the payment window is open - re-rendering the panel
      // underneath an in-progress payment is what was interrupting it.
      if (v && v.classList.contains('active') && !_isPayModalOpen()) {
        const hint = $('payLastUpdated');
        if (hint) hint.textContent = 'Updating…';
        loadPayments();
      }
    }, 7000);
    // Live panels: while a view is open, silently re-run its loader so management-side
    // changes (stage moves, new replies, published notices) appear without a manual
    // reload. Only the active view polls; the silent flag avoids a "Loading…" flicker.
    const _livePanel = (viewId, loader) => setInterval(() => {
      const v = $(viewId);
      if (v && v.classList.contains('active')) Promise.resolve(loader(true)).catch(() => {});
    }, 7000);
    _livePanel('view-guests',   loadMyGuests);
    _livePanel('view-defects',  loadMyDefects);
    _livePanel('view-parcels',  loadMyParcels);
    _livePanel('view-move',     loadMyMoves);
    _livePanel('view-feedback', loadMyFeedback);
    // My Bookings: pull the live stage so a management stage change (e.g. → Confirmed,
    // Completed, Cancelled) shows without a manual refresh. syncBookingStatuses
    // re-renders silently and keeps the last data on a transient failure.
    _livePanel('view-booking',  syncBookingStatuses);
    // Announcements (dedicated tab) and Resources - so newly published notices and
    // newly uploaded documents appear without a manual refresh.
    _livePanel('view-notices',   loadNotices);
    _livePanel('view-resources', loadResources);
    // Dashboard shows both announcements and booking cards - refresh both.
    _livePanel('view-dashboard', () => { loadNotices(); syncBookingStatuses(); });
  }

  // ── View switching ───────────────────────────────────────────────────────────
  function navigate(view) {
    document.querySelectorAll('.sidebar__item').forEach(el => el.classList.toggle('sidebar__item--active', el.dataset.view === view));
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
    window.scrollTo(0, 0);
    localStorage.setItem('portalLastView', view);
    if (view === 'booking')   { renderFacilities(); renderMyBookings(); syncBookingStatuses(); }
    if (view === 'dashboard') { renderDashboardBookings(); syncBookingStatuses(); loadNotices(); loadParcelNotice(); }
    if (view === 'guests')    loadMyGuests();
    if (view === 'defects')   loadMyDefects();
    if (view === 'move')      loadMyMoves();
    if (view === 'parcels')   loadMyParcels();
    if (view === 'feedback')  loadMyFeedback();
    if (view === 'notices')   loadNotices();
    if (view === 'messages')  loadMessages();
    if (view === 'payments')  loadPayments();
    if (view === 'resources') loadResources();
  }
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.view)));

  // ── Facility chooser ─────────────────────────────────────────────────────────
  function renderFacilities() {
    const grid = $('facilityGrid');
    if (!grid) return;
    grid.innerHTML = FACILITIES.map(f => `
      <div class="fac-card" data-fac="${f.key}" style="--fac-img:url('/asset/${f.key}.jpg')">
        <div class="fac-img-wrap">
          <div class="fac-img-overlay">Book Now</div>
        </div>
        <div class="fac-inner">
          <div class="fac-name">${esc(f.name)}</div>
          <div class="fac-row">
            <span class="fac-hours">${hoursLabel(f)}</span>
            <span class="fac-cap">${esc(f.capacity)}</span>
          </div>
        </div>
      </div>`).join('');
    grid.querySelectorAll('[data-fac]').forEach(el => el.addEventListener('click', () => openBooking(el.dataset.fac)));
  }

  // ── Booking modal ──────────────────────────────────────────────────────────
  const modal = $('bookingModal');
  const host  = $('bookingFormHost');
  let _fac = null;
  let _editing = null; // the booking object being edited, or null when creating

  function openBooking(key, edit) {
    const f = facByKey(key);
    if (!f || !host) return;
    _fac = f;
    _editing = edit || null;
    $('modalTitle').textContent = `${_editing ? 'Edit' : 'Book'} · ${f.name}`;

    const maxDate = f.maxAdvanceDays ? addDays(todaySGT(), f.maxAdvanceDays) : '';

    host.innerHTML = `
      <div class="bk">
        <div class="bk-banner" style="--fac-img:url('/asset/${f.key}.jpg')">
          <div class="bk-banner-info">
            <div class="bk-banner-name">${esc(f.name)}</div>
            <div class="bk-banner-meta">Open ${hoursLabel(f)} &nbsp;·&nbsp; ${esc(f.capacity)}</div>
          </div>
        </div>
        <div class="bk-form">
          <div class="bk-row">
            <div class="bk-field">
              <label>Date</label>
              <input type="date" id="bkDate" min="${todaySGT()}" ${maxDate ? `max="${maxDate}"` : ''} />
            </div>
            <div class="bk-field">
              <label>Pax${f.maxPax === 1 ? ' - residents only' : ` (max ${f.maxPax})`}</label>
              <input type="number" id="bkPax" min="1" max="${f.maxPax}" value="1"
                ${f.maxPax === 1 ? 'readonly class="bk-locked"' : ''} />
            </div>
          </div>
          <div class="bk-field">
            <label>Time Slot</label>
            <div class="bk-select-wrap">
              <select id="bkSlot"><option value="">select a date first</option></select>
              <span class="bk-select-chevron">▾</span>
            </div>
            <div class="bk-slot-hint" id="bkSlotHint"></div>
          </div>
          <div class="bk-rule">${esc(f.note)}</div>
          <div class="bk-field">
            <label>Notes (optional)</label>
            <textarea id="bkNotes" rows="2" placeholder="${esc(f.notePlaceholder)}"></textarea>
          </div>
          <div class="bk-err" id="bkErr"></div>
          <button class="bk-confirm" id="bkConfirm">${_editing ? 'Save Changes' : 'Confirm Booking'}</button>
        </div>
      </div>`;

    // Refresh slots whenever the date changes.
    $('bkDate').addEventListener('change', () => refreshSlots(f));
    $('bkConfirm').addEventListener('click', () => confirmBooking());
    modal.classList.add('open');

    // Pre-fill when editing, then load that date's slots and re-select the booked one.
    if (_editing) {
      $('bkPax').value   = _editing.pax || 1;
      $('bkNotes').value = _editing.notes || '';
      $('bkDate').value  = _editing.date;
      refreshSlots(f).then(() => {
        const sel = $('bkSlot');
        if (!sel) return;
        sel.value = _editing.slot;
        if (!sel.value) {
          const hint = $('bkSlotHint');
          if (hint) { hint.className = 'bk-slot-hint bk-slot-hint--warn'; hint.textContent = 'Your original slot is no longer available - please choose another.'; }
        }
      });
    }
  }

  function buildReviewHtml(f, date, slot, pax, notes) {
    return `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:#3f3832">
      <div style="display:flex;align-items:center;gap:10px;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid #e8e0d0">
        <span style="font-size:1.5rem;line-height:1">${f.emoji || '🏢'}</span>
        <div>
          <div style="font-size:1rem;font-weight:500;color:#14110f">${esc(f.name)}</div>
          <div style="font-size:0.65rem;color:#312e81;letter-spacing:0.08em;text-transform:uppercase">Unit ${esc(member.unit || '')}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px${notes ? ';margin-bottom:14px' : ''}">
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Date</div>
          <div style="color:#14110f">${fmtDate(date)}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Time</div>
          <div style="color:#14110f">${esc(slot)}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Guests</div>
          <div style="color:#14110f">${pax} ${pax === 1 ? 'person' : 'people'}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Member</div>
          <div style="color:#14110f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(member.name || '')}</div>
        </div>
      </div>
      ${notes ? `<div style="background:#faf7f2;border-radius:6px;padding:10px 12px">
        <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:3px">Notes</div>
        <div style="color:#5a514a;font-size:0.82rem">${esc(notes)}</div>
      </div>` : ''}
    </div>`;
  }

  function buildSuccessHtml(f, date, slot, pax, notes, bookingId) {
    const ref = !bookingId.startsWith('BK-') ? bookingId.slice(-8).toUpperCase() : bookingId;
    return `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:#3f3832">
      <div style="display:flex;align-items:center;gap:10px;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid #e8e0d0">
        <span style="font-size:1.5rem;line-height:1">${f.emoji || '🏢'}</span>
        <div style="font-size:1rem;font-weight:500;color:#14110f">${esc(f.name)}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px${notes ? ';margin-bottom:14px' : ''}">
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Date</div>
          <div style="color:#14110f">${fmtDate(date)}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Time</div>
          <div style="color:#14110f">${esc(slot)}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Guests</div>
          <div style="color:#14110f">${pax} ${pax === 1 ? 'person' : 'people'}</div>
        </div>
        <div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">Reference</div>
          <div style="color:#312e81;font-family:'Courier New',monospace;font-size:0.8rem;font-weight:600">${ref}</div>
        </div>
      </div>
      ${notes ? `<div style="background:#faf7f2;border-radius:6px;padding:10px 12px">
        <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:3px">Notes</div>
        <div style="color:#5a514a;font-size:0.82rem">${esc(notes)}</div>
      </div>` : ''}
    </div>`;
  }

  async function confirmBooking() {
    const f       = _fac;
    const editing = _editing;
    const date    = $('bkDate').value;
    const slot    = $('bkSlot').value;
    const pax     = parseInt($('bkPax').value, 10);
    const notes   = $('bkNotes').value.trim();
    const errEl   = $('bkErr');
    const btn     = $('bkConfirm');

    if (!date) { errEl.textContent = 'Please choose a date.'; return; }
    if (!slot)  { errEl.textContent = 'Please choose a time slot.'; return; }
    if (date === todaySGT() && parseSlotStart(slot) <= nowSGTMins()) {
      errEl.textContent = 'That time slot has already passed. Please choose another.'; return;
    }
    if (isNaN(pax) || pax < 1 || pax > f.maxPax) {
      errEl.textContent = `Pax must be between 1 and ${f.maxPax}.`; return;
    }
    if (f.maxBlocksPerDay) {
      const sameDayCount = getBookings().filter(b => b.facilityKey === f.key && b.date === date && !isFinished(b.status) && (!editing || b.id !== editing.id)).length;
      if (sameDayCount >= f.maxBlocksPerDay) {
        errEl.textContent = `Maximum ${f.maxBlocksPerDay} block${f.maxBlocksPerDay > 1 ? 's' : ''} of ${f.name} may be booked per day.`; return;
      }
    }

    errEl.textContent = '';

    // ── Step 1: Review before submitting ─────────────────────────────────
    if (window.Swal) {
      const { isConfirmed } = await window.Swal.fire({
        title:              editing ? 'Review Your Changes' : 'Review Your Booking',
        html:               buildReviewHtml(f, date, slot, pax, notes),
        showCancelButton:   true,
        confirmButtonText:  editing ? 'Save Changes' : 'Confirm &amp; Book',
        cancelButtonText:   '&#8592; Edit Details',
        confirmButtonColor: '#312e81',
        cancelButtonColor:  '#9a9088',
        reverseButtons:     true,
        focusConfirm:       false,
      });
      if (!isConfirmed) return;
    }

    // ── Step 2: Submit ────────────────────────────────────────────────────
    btn.disabled    = true;
    btn.textContent = editing ? 'Saving…' : 'Confirming…';

    try {
      // ── Edit an existing booking ──────────────────────────────────────
      if (editing) {
        const res  = await fetch(`/api/booking/${encodeURIComponent(editing.id)}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            facilityKey:  f.key,
            facilityName: f.name,
            date, slot, pax, notes,
            member_name:  member.name  || '',
            member_email: member.email || '',
            member_unit:  member.unit  || '',
          }),
        });
        const data = await res.json();
        if (!data.success) { errEl.textContent = data.message || 'Could not update booking.'; return; }

        const list = getBookings();
        const idx  = list.findIndex(b => b.id === editing.id);
        if (idx >= 0) { list[idx] = { ...list[idx], date, slot, pax, notes }; saveBookings(list); }

        closeModal(); renderMyBookings(); renderDashboardBookings(); syncBookingStatuses();

        if (window.Swal) {
          window.Swal.fire({
            icon:               'success',
            title:              'Booking Updated',
            html:               buildSuccessHtml(f, date, slot, pax, notes, editing.id),
            confirmButtonText:  'View My Bookings',
            confirmButtonColor: '#312e81',
          }).then(() => navigate('booking'));
        } else {
          toast('Booking updated!');
          navigate('booking');
        }
        return;
      }

      // ── Create a new booking ──────────────────────────────────────────
      const res  = await fetch('/api/booking', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          facilityKey:  f.key,
          facilityName: f.name,
          emoji:        f.emoji,
          date, slot, pax, notes,
          contact_id:   member.contact_id  || '',
          member_name:  member.name        || '',
          member_email: member.email       || '',
          member_unit:  member.unit        || '',
        }),
      });
      const data = await res.json();

      if (!data.success) {
        errEl.textContent = data.message || 'Booking failed. Please try again.';
        return;
      }

      const bookingId = data.appointmentId || ('BK-' + date.replace(/-/g,'') + '-' + Math.floor(Math.random()*9000+1000));
      const oppId     = data.opportunity_id || '';
      const list = getBookings();
      // No-deposit facilities auto-confirm (past dates are blocked and taken slots
      // disabled, so no manual approval is needed). Deposit facilities sit at
      // "Deposit Pending" until the deposit is paid. The "Requested" stage is retired.
      // Store the opportunity id so the deposit modal can record per-fee payments
      // against the SAME opp the Payments tab reads from.
      list.push({ id: bookingId, oppId, facilityKey: f.key, facilityName: f.name, emoji: f.emoji, date, slot, pax, notes, ts: Date.now(), status: isDepositFacility(f.key) ? 'Deposit Pending' : 'Confirmed' });
      saveBookings(list);

      closeModal(); renderMyBookings(); renderDashboardBookings();
      syncBookingStatuses(); // reconcile with the server (Mongo) record

      // Deposit facilities → prompt to go to Payments tab. Others → confirm directly.
      if (isDepositFacility(f.key)) {
        if (window.Swal) {
          window.Swal.fire({
            icon:               'success',
            title:              'Booking Saved!',
            html:               `Your <b>${esc(f.name)}</b> booking is pending deposit.<br><br>Go to the <b>Payments</b> tab to pay your deposit and confirm it.`,
            confirmButtonText:  'Go to Payments',
            showCancelButton:   true,
            cancelButtonText:   'Later',
            confirmButtonColor: '#312e81',
            cancelButtonColor:  '#9a9088',
          }).then(r => { if (r.isConfirmed) navigate('payments'); });
        } else {
          toast('Booking saved! Pay your deposit from the Payments tab.');
        }
      } else if (window.Swal) {
        window.Swal.fire({
          icon:               'success',
          title:              'Booking Confirmed',
          html:               buildSuccessHtml(f, date, slot, pax, notes, bookingId),
          confirmButtonText:  'View My Bookings',
          confirmButtonColor: '#312e81',
        }).then(() => navigate('booking'));
      } else {
        toast('Booking confirmed!');
        navigate('booking');
      }

    } catch {
      errEl.textContent = 'Connection error. Please try again.';
    } finally {
      btn.disabled    = false;
      btn.textContent = editing ? 'Save Changes' : 'Confirm Booking';
    }
  }

  // Quantum payment links per deposit facility / move. Each entry is one or more fees.
  // DEMO: external payment links removed. "Pay Deposit" opens a local mock payment
  // page (public/demo-pay.html) in the modal iframe - no external call is made.
  const PAY_LINKS = {
    bbq:  [{ label: 'Refundable Deposit', url: 'demo-pay.html' }],
    pool: [{ label: 'Refundable Deposit', url: 'demo-pay.html' }],
    move: [{ label: 'Admin Fee + Refundable Deposit', url: 'demo-pay.html' }],
  };
  const VERANDAH_FEES = [
    { label: 'Booking Fee + Refundable Deposit', feeLabel: 'deposit', amount: 600, url: 'demo-pay.html' },
  ];
  // A facility requires a deposit if it has payment links OR is the Verandah
  // (whose fees live in VERANDAH_FEES, not PAY_LINKS).
  function isDepositFacility(key) {
    const f = FACILITIES.find(x => x.key === key);
    return !!(f && f.deposit) || key === 'verandah' || !!PAY_LINKS[key];
  }
  // Append the resident's name + email so the Quantum payment link is pre-filled.
  // Sent under several common param spellings since the exact keys vary.
  function prefillLink(url) {
    const parts = String(member.name || '').trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || '';
    const last  = parts.length > 1 ? parts.slice(1).join(' ') : '';
    const full  = String(member.name || '').trim();
    const p = new URLSearchParams();
    const set = (k, v) => { if (v) p.set(k, v); };
    set('name', full); set('full_name', full); set('fullName', full);
    set('first_name', first); set('firstName', first); set('fname', first);
    set('last_name', last);  set('lastName', last);  set('lname', last);
    set('email', member.email); set('customer_email', member.email);
    const q = p.toString();
    return q ? url + (url.includes('?') ? '&' : '?') + q : url;
  }
  function closeModal() { if (modal) { modal.classList.remove('open'); if (host) host.innerHTML = ''; } _editing = null; }
  if (modal) {
    bind('modalCloseBtn', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }

  // ── My Bookings ──────────────────────────────────────────────────────────────
  const UPCOMING_STATUSES = ['Confirmed', 'Deposit Pending'];
  const isUpcoming = s => UPCOMING_STATUSES.includes(s);

  function _bkTableHTML(rows, showActions) {
    if (!rows.length) return null;
    return '<div class="bk-table-scroll"><table class="data-table"><thead><tr>'
      + '<th>Facility</th><th>Date</th><th>Time</th><th>Pax</th><th>Status</th>'
      + (showActions ? '<th>Actions</th>' : '')
      + '</tr></thead><tbody>'
      + rows.map(b => {
          const actions = showActions
            ? `<span class="bk-edit" data-edit="${b.id}">Edit</span> &nbsp;·&nbsp; <span class="bk-cancel" data-cancel="${b.id}">Cancel</span>`
            : '';
          const hasNote = b.notes && b.notes.trim();
          const noteToggle = hasNote
            ? ` &nbsp;·&nbsp; <span class="bk-note-toggle" data-note="${b.id}">Notes <span class="phi">▸</span></span>`
            : '';
          const row = `<tr><td>${b.emoji} ${esc(b.facilityName)}</td><td style="font-size:0.8rem">${fmtDate(b.date)}</td><td style="font-size:0.8rem">${esc(b.slot)}</td><td style="font-size:0.8rem">${b.pax || 1}</td><td><span class="sbadge ${stageBadge(b.status)}">${esc(b.status)}</span></td>${showActions ? `<td style="white-space:nowrap">${actions}${noteToggle}</td>` : ''}</tr>`;
          const noteRow = hasNote
            ? `<tr class="bk-note-row" id="bknote-${b.id}" style="display:none"><td colspan="${showActions ? 6 : 5}" style="font-size:0.78rem;color:var(--text-2,#5a514a)"><span style="color:var(--gold,#312e81);font-weight:600">Note:</span> ${esc(b.notes)}</td></tr>`
            : '';
          return row + noteRow;
        }).join('')
      + '</tbody></table></div>';
  }

  function _bindBkListEvents(container) {
    container.querySelectorAll('[data-note]').forEach(t => t.addEventListener('click', () => {
      const nr = $('bknote-' + t.dataset.note);
      if (!nr) return;
      const open = nr.style.display === 'none';
      nr.style.display = open ? 'table-row' : 'none';
      t.querySelector('.phi').textContent = open ? '▾' : '▸';
      if (nr.previousElementSibling) nr.previousElementSibling.classList.toggle('bk-note-open', open);
    }));
    container.querySelectorAll('[data-edit]').forEach(x => x.addEventListener('click', () => {
      const b = getBookings().find(bk => bk.id === x.dataset.edit);
      if (b) openBooking(b.facilityKey, b);
    }));
    container.querySelectorAll('[data-cancel]').forEach(x => x.addEventListener('click', async () => {
      if (window.Swal) {
        const { isConfirmed } = await window.Swal.fire({
          title:              'Cancel this booking?',
          text:               'This cannot be undone.',
          icon:               'warning',
          showCancelButton:   true,
          confirmButtonText:  'Yes, cancel it',
          cancelButtonText:   'Keep Booking',
          confirmButtonColor: '#9f1f16',
          cancelButtonColor:  '#312e81',
          reverseButtons:     true,
        });
        if (!isConfirmed) return;
      }
      const bkId = x.dataset.cancel;
      const bk   = getBookings().find(b => b.id === bkId) || {};
      saveBookings(getBookings().map(b => b.id === bkId ? { ...b, status: 'Cancelled' } : b));
      renderMyBookings(); renderDashboardBookings();
      toast('Booking cancelled.');
      if (bkId && !bkId.startsWith('BK-')) {
        const qs = new URLSearchParams();
        if (bk.facilityName) qs.set('facility', bk.facilityName);
        if (bk.date)         qs.set('date', bk.date);
        if (bk.oppId)        qs.set('opp_id', bk.oppId);
        const q = qs.toString();
        try { await fetch(`/api/booking/${encodeURIComponent(bkId)}${q ? '?' + q : ''}`, { method: 'DELETE' }); }
        catch (e) { console.warn('[cancel] GHL cancel failed (non-fatal):', e); }
        syncBookingStatuses();
      }
    }));
  }

  function renderMyBookings() {
    const all      = getBookings().sort((a, b) => a.date.localeCompare(b.date));
    const upcoming = all.filter(b => isUpcoming(b.status));
    const history  = all.filter(b => isFinished(b.status)).reverse(); // most recent first

    const upEl  = $('myUpcomingList');
    const hisEl = $('myHistoryList');

    if ($('myUpcomingCount')) $('myUpcomingCount').textContent = upcoming.length + ' Active';
    if ($('myHistoryCount'))  $('myHistoryCount').textContent  = history.length + ' Records';

    if (upEl) {
      const html = _bkTableHTML(upcoming, true);
      upEl.innerHTML = html || '<div class="panel-empty">No upcoming bookings. Select a facility above to get started.</div>';
      if (html) _bindBkListEvents(upEl);
    }
    if (hisEl) {
      const html = _bkTableHTML(history, false);
      hisEl.innerHTML = html || '<div class="panel-empty">No past bookings on record.</div>';
      if (html) _bindBkListEvents(hisEl);
    }
  }

  function renderDashboardBookings() {
    const today = todaySGT();
    const up = getBookings().filter(b => b.date >= today && !isFinished(b.status)).sort((a, b) => a.date.localeCompare(b.date));
    if ($('bookingCountBadge')) $('bookingCountBadge').textContent = up.length + ' Active';
    if (up.length) {
      if ($('nextBookingTitle')) $('nextBookingTitle').textContent = `${up[0].emoji} ${up[0].facilityName}`;
      if ($('nextBookingTime'))  $('nextBookingTime').textContent  = `${fmtDate(up[0].date)} · ${up[0].slot}`;
    } else {
      if ($('nextBookingTitle')) $('nextBookingTitle').textContent = 'No upcoming bookings';
      if ($('nextBookingTime'))  $('nextBookingTime').textContent  = '';
    }
    const db = $('dashBookings');
    if (db) db.innerHTML = !up.length ? '<div class="panel-empty">No bookings on record.</div>'
      : up.slice(0, 5).map(b => `<div class="booking-row"><div><div class="booking-facility">${b.emoji} ${esc(b.facilityName)}</div><div class="booking-time">${fmtDate(b.date)} · ${esc(b.slot)}</div></div><span class="sbadge ${stageBadge(b.status)}">${esc(b.status)}</span></div>`).join('');
  }

  // Populate the "linked booking" dropdown in the guest form with upcoming bookings.
  function populateBookingSelector() {
    const sel = $('gLinkedBooking');
    if (!sel) return;
    const today = todaySGT();
    const upcoming = getBookings()
      .filter(b => b.date >= today && !isFinished(b.status))
      .sort((a, b) => a.date.localeCompare(b.date));
    const prev = sel.value;
    sel.innerHTML = '<option value="">No linked booking</option>'
      + upcoming.map(b => {
          const label = `${b.emoji || ''} ${b.facilityName} · ${fmtDate(b.date)} · ${b.slot}`;
          return `<option value="${esc(b.id)}">${esc(label)}</option>`;
        }).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    updateGuestBookingStatus();
  }

  // Show status indicator under the linked booking selector and gate the submit button.
  function updateGuestBookingStatus() {
    const sel      = $('gLinkedBooking');
    const statusEl = $('gBookingStatus');
    const btn      = $('gRegisterBtn');
    if (!sel || !statusEl) return;
    const id = sel.value;
    if (!id) {
      statusEl.style.display = 'none';
      if (btn) btn.disabled = false;
      return;
    }
    const booking = getBookings().find(b => b.id === id);
    if (!booking) { statusEl.style.display = 'none'; return; }
    statusEl.style.display = '';
    if (booking.status === 'Confirmed') {
      statusEl.style.cssText = 'display:block;margin-top:6px;font-size:0.8rem;padding:8px 12px;border-radius:6px;line-height:1.5;background:rgba(39,174,96,.1);color:#27ae60;border:1px solid rgba(39,174,96,.3)';
      statusEl.textContent = '✓ Booking confirmed - your visitors can be registered.';
      if (btn) btn.disabled = false;
    } else {
      statusEl.style.cssText = 'display:block;margin-top:6px;font-size:0.8rem;padding:8px 12px;border-radius:6px;line-height:1.5;background:rgba(192,57,43,.08);color:#c0392b;border:1px solid rgba(192,57,43,.25)';
      statusEl.textContent = `This booking is still ${booking.status.toLowerCase()}. Please wait for it to be confirmed before registering guests for this event.`;
      if (btn) btn.disabled = true;
    }
  }

  // Hydrate the in-memory booking cache from the server (MongoDB - the source of
  // truth, with the live GHL pipeline stage overlaid). Replaces the booking list
  // wholesale, so cancellations / management stage moves are always reflected.
  // Keeps the cache on a failed/non-success response so a transient error can't wipe
  // the list. (Named syncBookingStatuses for its existing call sites.)
  async function syncBookingStatuses() {
    const cid   = member && member.contact_id;
    const email = member && member.email;
    if (!cid && !email) return;
    const qs = new URLSearchParams();
    if (cid)   qs.set('contact_id', cid);
    if (email) qs.set('email', email);
    try {
      const res  = await fetch(`/api/booking/mine?${qs.toString()}`);
      const data = await res.json();
      if (!data || !data.success) return;
      _bookings = (data.items || []).map(it => ({
        id:           it.id,
        facilityKey:  it.facilityKey,
        facilityName: it.facilityName || it.facility,
        emoji:        it.emoji || FAC_EMOJI[it.facilityKey] || '',
        date:         it.date,
        slot:         it.slot,
        pax:          it.pax || 1,
        notes:        it.notes || '',
        status:       it.status || it.stage || 'Confirmed',
        oppId:        it.oppId || '',
      }));
    } catch { return; }
    renderMyBookings(); renderDashboardBookings(); populateBookingSelector();
  }

  // ── My Guests & My Defects ───────────────────────────────────────────────────
  function stageBadge(stage) {
    const map = {
      'Registered':           'sbadge-submitted',
      'Checked In':           'sbadge-acknowledged',
      'Checked Out':          'sbadge-in-progress',
      'Departed':             'sbadge-resolved',
      'Reported':             'sbadge-reported',
      'Acknowledged':         'sbadge-acknowledged',
      'In Progress':          'sbadge-in-progress',
      'Resolved':             'sbadge-resolved',
      'Closed':               'sbadge-closed',
      'Received':             'sbadge-acknowledged',
      'Notified':             'sbadge-submitted',
      'Collected':            'sbadge-resolved',
      'Uncollected / Returned':'sbadge-closed',
      'Requested':            'sbadge-submitted',
      'Deposit Pending':      'sbadge-reported',
      'Deposit Paid':         'sbadge-acknowledged',
      'Confirmed':            'sbadge-confirmed',
      'Completed':            'sbadge-resolved',
      'No-Show':              'sbadge-cancelled',
      'Cancelled':            'sbadge-cancelled',
      'Deposit Refunded':     'sbadge-resolved',
      'Submitted':            'sbadge-submitted',
      'Under Review':         'sbadge-acknowledged',
    };
    return map[stage] || 'sbadge-default';
  }

  const REF_RE = /GST-\d{8}-\d{4}/;

  // ── Guest pass QR ────────────────────────────────────────────────────────────
  function guestQrUrl(ref) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=14&data=${encodeURIComponent(ref)}`;
  }
  function showGuestQr(ref) {
    const url = guestQrUrl(ref);
    if (!window.Swal) { window.open(`${url}&download=1`, '_blank'); return; }
    window.Swal.fire({
      title:              'Guest Pass',
      html:               `<div style="text-align:center">
        <div style="font-size:0.8rem;color:#312e81;font-family:'Courier New',monospace;font-weight:600;letter-spacing:0.04em;margin-bottom:12px">${esc(ref)}</div>
        <img src="${url}" alt="Guest Pass QR" style="width:230px;height:230px;border-radius:10px;border:1px solid #e8e0d0"
          onerror="this.outerHTML='<div style=padding:16px;color:var(--muted,#9a9088);font-size:0.82rem>QR unavailable. Use your reference code at the guardhouse.</div>'">
        <div style="margin-top:14px">
          <a href="${url}&download=1" download="guest-pass-${esc(ref)}.png" target="_blank" rel="noopener"
             style="display:inline-block;background:#312e81;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:0.82rem;font-weight:600">&#10515; Download QR</a>
        </div>
        <div style="margin-top:10px;font-size:0.72rem;color:#9a9088">Show this at the guardhouse on arrival.</div>
      </div>`,
      confirmButtonText:  'Done',
      confirmButtonColor: '#312e81',
    });
  }

  function renderRecords(el, cnt, items, emptyMsg, opts) {
    opts = opts || {};
    if (cnt) cnt.textContent = (items ? items.length : 0) + ' Total';
    if (!items || !items.length) { el.innerHTML = `<div class="panel-empty">${emptyMsg}</div>`; return; }
    // Defect opportunity names carry the reported issue (sometimes prefixed with an
    // [urgency] tag) - surface that as the title + a body row, not just the date.
    const cleanIssue = (s) => String(s || '').replace(/^\[(?:emergency|urgent|routine)\]\s*/i, '').trim();
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const daySGT = (iso) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); } catch { return ''; } };
    const savedPool = (opts.saved || []).slice(); // newest-first, mirrors the reports order
    el.innerHTML = items.map(item => {
      const badge = stageBadge(item.stage);
      const date  = item.createdAt
        ? new Date(item.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' })
        : ' - ';
      const issue = opts.kind === 'defect' ? cleanIssue(item.name) : '';
      // The GHL opp name is "<category> | - #unit", not the typed text. Recover the
      // resident's full description from local history: prefer same category + same
      // day, then same day, then next in order. Each saved entry is used once.
      let sv = null;
      if (opts.kind === 'defect' && savedPool.length) {
        const ni = norm(item.name), iDay = daySGT(item.createdAt);
        const cat = (s) => norm(String(s.category || '').split(/[|+]/)[0]);
        let k = savedPool.findIndex(s => cat(s) && ni.includes(cat(s)) && daySGT(s.ts) === iDay);
        if (k < 0) k = savedPool.findIndex(s => daySGT(s.ts) === iDay);
        if (k < 0) k = 0;
        sv = savedPool[k]; savedPool.splice(k, 1);
      }
      // Parcels: match the resident's saved submission by reference, then date, then order.
      if (opts.kind === 'parcel' && savedPool.length) {
        const ni = norm(item.name), iDay = daySGT(item.createdAt);
        let k = savedPool.findIndex(s => s.ref && ni.includes(norm(s.ref)));
        if (k < 0) k = savedPool.findIndex(s => daySGT(s.ts) === iDay);
        if (k < 0) k = 0;
        sv = savedPool[k]; savedPool.splice(k, 1);
      }
      // Moves: match by move type/date in the name, then submission date, then order.
      if (opts.kind === 'move' && savedPool.length) {
        const ni = norm(item.name), iDay = daySGT(item.createdAt);
        let k = savedPool.findIndex(s => s.move_date && ni.includes(norm(s.move_date)));
        if (k < 0) k = savedPool.findIndex(s => daySGT(s.ts) === iDay);
        if (k < 0) k = 0;
        sv = savedPool[k]; savedPool.splice(k, 1);
      }
      // Feedback: match by submission date, then order.
      if (opts.kind === 'feedback' && savedPool.length) {
        const iDay = daySGT(item.createdAt);
        let k = savedPool.findIndex(s => daySGT(s.ts) === iDay);
        if (k < 0) k = 0;
        sv = savedPool[k]; savedPool.splice(k, 1);
      }
      // Prefer the resident's actual submission date (GHL createdAt can reflect an
      // older deduped/contact record).
      const subDate = (sv && sv.ts)
        ? new Date(sv.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' })
        : date;

      // Extract guest reference from name or any custom field value
      let refCode = (REF_RE.exec(item.name) || [])[0] || '';

      const fields = (item.customFields || []).map(f => {
        const v = f.fieldValueString || '';
        const label = f.label;
        if (!refCode) { const m = REF_RE.exec(v); if (m) refCode = m[0]; }
        if (/^https?:\/\/api\.qrserver\.com/.test(v)) return '';
        if (REF_RE.test(v)) return `<div class="rec-field"><span class="rec-label">${esc(label || 'Ref')}</span><span class="rec-ref">${esc(v)}</span></div>`;
        return `<div class="rec-field"><span class="rec-label">${esc(label || 'Detail')}</span>${esc(v)}</div>`;
      }).join('');

      // Only guest records carry a GST- reference → offer a QR pass button +
      // an inline preview (both downloadable).
      const qrBtn = refCode
        ? `<button class="rec-qr-btn" type="button" data-qr-ref="${esc(refCode)}" title="Show guest pass QR" aria-label="Show guest pass QR"><span class="material-symbols-outlined">qr_code_2</span> QR</button>`
        : '';
      const qrHtml = refCode ? (() => {
        const qrUrl = guestQrUrl(refCode);
        return `<div class="rec-qr">
          <img src="${qrUrl}" alt="Guest Pass QR" class="qr-img" loading="lazy"
            onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <div class="qr-err" style="display:none">QR unavailable - show reference code at guardhouse.</div>
          <a href="${qrUrl}&download=1" class="qr-dl-btn" target="_blank" rel="noopener">
            <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:-2px">download</span> Download QR
          </a>
        </div>`;
      })() : '';

      // If ref wasn't already emitted by a custom field, show it explicitly
      const refInFields = (item.customFields || []).some(f => REF_RE.test(f.fieldValueString || ''));
      const refRow = refCode && !refInFields
        ? `<div class="rec-field"><span class="rec-label">Ref</span><span class="rec-ref">${esc(refCode)}</span></div>`
        : '';

      return `<details class="rec-item">
        <summary class="rec-summary">
          <div class="rec-main">
            <span class="rec-name">${esc(item.displayName || issue || item.name)}</span>
            <span class="rec-meta">${subDate}</span>
          </div>
          ${qrBtn}
          <span class="sbadge ${badge}">${esc(item.stage)}</span>
          <span class="rec-chevron">›</span>
        </summary>
        <div class="rec-body">
          ${opts.kind === 'defect' ? (() => {
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const cat   = (sv && sv.category) || issue.split('|')[0].split('')[0].trim() || '';
            const urg   = (sv && sv.urgency) || (item.name.match(/\[(emergency|urgent|routine)\]/i) || [])[1] || '';
            return `
              <div class="rec-field"><span class="rec-label">Submitted date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Category</span>${esc(cat)}</div>
              <div class="rec-field"><span class="rec-label">Location</span>${esc((sv && sv.location) || '')}</div>
              <div class="rec-field"><span class="rec-label">Urgency Level</span>${esc(urg)}</div>
              <div class="rec-field"><span class="rec-label">Issue</span>${esc((sv && sv.desc) || '')}</div>`;
          })() : opts.kind === 'parcel' ? (() => {
            // Fall back to the parcel's GHL custom fields when no local copy exists.
            const cf = (re) => { const f = (item.customFields || []).find(c => re.test(c.label || '')); return f ? (f.fieldValueString || '') : ''; };
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const ref   = (sv && sv.ref) || cf(/reference|tracking/i) || (REF_RE.exec(item.name) || [])[0] || cleanIssue(item.name) || '';
            const courier   = (sv && sv.courier) || cf(/courier|sender/i);
            const descTxt   = (sv && sv.desc) || cf(/description|item|content/i);
            const collector = (sv && sv.collector && sv.collector.trim()) || cf(/collector|authoriz/i);
            return `
              <div class="rec-field"><span class="rec-label">Date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Parcel Reference</span>${esc(ref)}</div>
              <div class="rec-field"><span class="rec-label">Courier / Sender</span>${esc(courier || '')}</div>
              <div class="rec-field"><span class="rec-label">Description</span>${esc(descTxt || '')}</div>
              ${collector ? `<div class="rec-field"><span class="rec-label">Authorized Collector</span>${esc(collector)}</div>` : ''}`;
          })() : opts.kind === 'move' ? (() => {
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const mType = (sv && sv.move_type) || (item.name.split('')[0].trim()) || '';
            const mDate = (sv && sv.move_date) ? fmtDate(sv.move_date) : '';
            return `
              <div class="rec-field"><span class="rec-label">Submitted Date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Move Type</span>${esc(mType)}</div>
              <div class="rec-field"><span class="rec-label">Move In/Out Date</span>${esc(mDate)}</div>
              <div class="rec-field"><span class="rec-label">Move In/Out Time</span>${esc((sv && sv.move_time) || '')}</div>
              <div class="rec-field"><span class="rec-label">Notes</span>${esc((sv && sv.notes) || '')}</div>`;
          })() : opts.kind === 'feedback' ? (() => {
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const type  = (sv && sv.type) || '';
            const descLabel = type === 'Complaint' ? 'What Happened?' : type === 'Suggestion' ? 'Your Suggestion' : type === 'Feedback' ? 'Your Feedback' : 'Details';
            const incDate = (sv && sv.incident_date) ? fmtDate(sv.incident_date) : '';
            return `
              <div class="rec-field"><span class="rec-label">Submitted Date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Type</span>${esc(type)}</div>
              <div class="rec-field"><span class="rec-label">Category</span>${esc((sv && sv.category) || '')}</div>
              <div class="rec-field"><span class="rec-label">Date of Incident</span>${esc(incDate)}</div>
              <div class="rec-field"><span class="rec-label">Time of Incident</span>${esc((sv && sv.incident_time) || '')}</div>
              <div class="rec-field"><span class="rec-label">${esc(descLabel)}</span>${esc((sv && sv.desc) || '')}</div>`;
          })() : `
          ${refRow}${fields}${qrHtml}
          <div class="rec-field"><span class="rec-label">Submitted</span>${date}</div>`}
        </div>
      </details>`;
    }).join('');

    // Clicking the QR button opens the pass without toggling the <details>.
    el.querySelectorAll('[data-qr-ref]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      showGuestQr(btn.dataset.qrRef);
    }));
  }

  // Build the opportunities URL for a pipeline, passing BOTH the session contact id
  // and the email so the server can resolve the canonical contact (robust to a
  // stale/empty session contact_id).
  function oppUrl(pipeline) {
    const qs = new URLSearchParams({ pipeline });
    if (member && member.contact_id) qs.set('contact_id', member.contact_id);
    if (member && member.email)      qs.set('email', member.email);
    return `/api/opportunities?${qs.toString()}`;
  }

  async function loadMyGuests(silent) {
    const el  = $('myGuestsList');
    const cnt = $('myGuestsCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const res  = await fetch(oppUrl('guest'));
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load guests.')}</div>`; return; }
      // Extract visitor name from "GST-YYYYMMDD-#### - Visitor Name (#unit)"
      const GUEST_VISITOR_RE = / - \s*(.+?)\s*(?:\(#?[^)]+\))?\s*$/;
      (data.items || []).forEach(item => {
        const m = GUEST_VISITOR_RE.exec(item.name || '');
        if (m) item.displayName = m[1].trim();
      });
      renderRecords(el, cnt, data.items, 'No registered guests on record.');
    } catch (e) { console.error('[guests]', e); el.innerHTML = '<div class="panel-empty">Connection error loading guests.</div>'; }
  }

  async function loadMyDefects(silent) {
    const el  = $('myDefects');
    const cnt = $('myDefectsCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const [res, saved] = await Promise.all([fetch(oppUrl('defect')), fetchMine('defect')]);
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load reports.')}</div>`; return; }
      renderRecords(el, cnt, data.items, 'No defect reports on record.', { kind: 'defect', saved });
    } catch (e) { console.error('[defects]', e); el.innerHTML = '<div class="panel-empty">Connection error loading reports.</div>'; }
  }

  // ── Feedback category filter ─────────────────────────────────────────────────
  const FB_CATEGORIES = {
    'Complaint':  ['Noise', 'Cleanliness', 'Security Concern', 'Maintenance Issue', 'Neighbour Dispute', 'Facility Condition', 'Staff Conduct', 'Others'],
    'Feedback':   ['Facilities', 'Management', 'Security', 'Maintenance', 'Staff', 'Community', 'Others'],
    'Suggestion': ['Amenities & Facilities', 'Community Events', 'Green Initiatives', 'Technology & Systems', 'Safety & Security', 'Others'],
  };
  const FB_PLACEHOLDERS = {
    'Complaint':  'Describe the incident in detail…',
    'Feedback':   'Share your feedback…',
    'Suggestion': 'Describe your suggestion…',
  };
  const FB_DESC_LABELS = {
    'Complaint':  'What Happened?',
    'Feedback':   'Your Feedback',
    'Suggestion': 'Your Suggestion',
  };

  function updateFbCategories() {
    const type = $('fbType') ? $('fbType').value : 'Complaint';
    const cats = FB_CATEGORIES[type] || FB_CATEGORIES['Complaint'];
    const sel  = $('fbCategory');
    if (!sel) return;
    sel.innerHTML = cats.map(c => `<option>${c}</option>`).join('');
    if ($('fbDesc')) {
      $('fbDesc').placeholder = FB_PLACEHOLDERS[type] || '';
      const label = $('fbDesc').closest('.form-group')?.querySelector('label');
      if (label) label.textContent = FB_DESC_LABELS[type] || 'Description';
    }
  }
  const fbTypeEl = $('fbType');
  if (fbTypeEl) fbTypeEl.addEventListener('change', updateFbCategories);

  async function loadMyFeedback(silent) {
    const el  = $('myFeedback');
    const cnt = $('myFeedbackCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const [res, saved] = await Promise.all([fetch(oppUrl('feedback')), fetchMine('feedback')]);
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load submissions.')}</div>`; return; }
      renderRecords(el, cnt, data.items, 'No submissions on record.', { kind: 'feedback', saved });
    } catch (e) { console.error('[feedback]', e); el.innerHTML = '<div class="panel-empty">Connection error loading submissions.</div>'; }
  }

  async function loadMyMoves(silent) {
    const el  = $('myMovesList');
    const cnt = $('myMovesCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const [res, saved] = await Promise.all([fetch(oppUrl('move')), fetchMine('move')]);
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load move bookings.')}</div>`; return; }
      renderRecords(el, cnt, data.items, 'No move bookings on record.', { kind: 'move', saved });
    } catch (e) { console.error('[moves]', e); el.innerHTML = '<div class="panel-empty">Connection error loading move bookings.</div>'; }
  }

  async function loadMyParcels(silent) {
    const el  = $('parcelList');
    const cnt = $('parcelCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const [res, saved] = await Promise.all([fetch(oppUrl('parcel')), fetchMine('parcel')]);
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load parcels.')}</div>`; return; }
      renderRecords(el, cnt, data.items, 'No parcels on record.', { kind: 'parcel', saved });
    } catch (e) { console.error('[parcels]', e); el.innerHTML = '<div class="panel-empty">Connection error loading parcels.</div>'; }
  }

  async function loadParcelNotice() {
    const banner = $('parcelNoticeBanner');
    const text   = $('parcelNoticeText');
    if (!banner || !text || !member) return;
    try {
      const res  = await fetch(oppUrl('parcel'));
      const data = await res.json();
      if (!data.success) return;
      const awaiting = (data.items || []).filter(i => i.stage === 'Received' || i.stage === 'Notified');
      if (awaiting.length > 0) {
        text.textContent = awaiting.length === 1
          ? 'You have 1 parcel awaiting collection at the guardhouse.'
          : `You have ${awaiting.length} parcels awaiting collection at the guardhouse.`;
        banner.style.display = 'flex';
      } else {
        banner.style.display = 'none';
      }
    } catch { banner.style.display = 'none'; }
  }

  // ── Notices & AGM (announcements published by management) ─────────────────────
  function annDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }) : '';
  }
  function annEventLabel(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }) : '';
  }
  function annTimeOnly(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }) : '';
  }
  // Human label for an announcement's event window: single instant, same-day range, or full range.
  function annWhen(a) {
    if (!a.eventAt) return '';
    if (!a.eventEndAt) return annEventLabel(a.eventAt);
    return annDate(a.eventAt) === annDate(a.eventEndAt)
      ? `${annEventLabel(a.eventAt)} - ${annTimeOnly(a.eventEndAt)}`
      : `${annEventLabel(a.eventAt)} → ${annEventLabel(a.eventEndAt)}`;
  }
  async function loadNotices() {
    let items = [];
    try {
      const res  = await fetch('/api/announcements');
      const data = await res.json();
      if (data && data.success) items = data.announcements || [];
    } catch { return; }

    function catSlug(cat) {
      const c = (cat || '').toLowerCase();
      if (c.includes('maint'))                  return 'maintenance';
      if (c.includes('agm') || c.includes('egm')) return 'agm';
      if (c.includes('rule'))                   return 'rule-change';
      if (c.includes('event'))                  return 'event';
      if (c.includes('safety'))                 return 'safety';
      return 'general';
    }

    // Fetch resident's existing RSVPs if any events have RSVP enabled.
    let myRsvpMap = {};
    if (items.some(a => a.rsvp_enabled) && member && member.contact_id) {
      try {
        const rr = await fetch(`/api/rsvp/mine?contact_id=${encodeURIComponent(member.contact_id)}`);
        const rd = await rr.json();
        if (rd.success) myRsvpMap = rd.rsvps || {};
      } catch {}
    }

    function rsvpHtml(a, existing) {
      if (!a.rsvp_enabled) return '';
      const isYes   = existing && existing.response === 'yes';
      const isNo    = existing && existing.response === 'no';
      const count   = (existing && existing.attendee_count) || 1;
      const closed  = a.eventAt && (new Date(a.eventAt) - Date.now() < 24 * 60 * 60 * 1000);
      const dis     = closed ? ' disabled' : '';
      return `
        <div class="ann-rsvp" data-ann-id="${esc(a.id)}"${closed ? ' data-closed="1"' : ''}>
          <div class="ann-rsvp__label">Will you be attending?</div>
          <div class="ann-rsvp__btns">
            <button class="ann-rsvp__btn ann-rsvp__yes${isYes ? ' ann-rsvp__active' : ''}" data-response="yes"${dis}>✓ Yes</button>
            <button class="ann-rsvp__btn ann-rsvp__no${isNo  ? ' ann-rsvp__active' : ''}" data-response="no"${dis}>✗ No</button>
          </div>
          <div class="ann-rsvp__count${isYes ? '' : ' ann-rsvp__hidden'}">
            <label class="ann-rsvp__count-label">How many people are coming? <input class="ann-rsvp__num" type="number" min="1" max="20" value="${count}"${dis} /></label>
          </div>
          <div class="ann-rsvp__footer">
            ${closed
              ? '<span class="ann-rsvp__closed">Responses are closed - this event is less than 24 hours away.</span>'
              : `<button class="ann-rsvp__submit${existing ? '' : ' ann-rsvp__hidden'}">${existing ? 'Change my response' : 'Submit'}</button>`}
            <div class="ann-rsvp__status">${isYes ? `You're attending${count > 1 ? ` with ${count - 1} guest${count - 1 !== 1 ? 's' : ''}` : ''}.` : isNo ? "You're not attending." : ''}</div>
          </div>
        </div>`;
    }

    const list = $('noticesList');
    if (list) {
      list.innerHTML = items.length
        ? items.map(a => `
          <article class="ann-card${a.pinned ? ' ann-card--pinned' : ''}">
            <div class="ann-card__header">
              <div class="ann-card__meta">
                <span class="ann-card__cat ann-cat--${catSlug(a.category)}">${esc(a.category || 'General')}</span>
                ${a.pinned ? '<span class="material-symbols-outlined ann-card__pin">push_pin</span>' : ''}
              </div>
              <time class="ann-card__date">${esc(annDate(a.createdAt))}</time>
            </div>
            <h3 class="ann-card__title">${esc(a.title)}</h3>
            ${a.eventAt ? `<div class="ann-card__event"><span class="material-symbols-outlined ann-card__event-icon">event</span>${esc(annWhen(a))}</div>` : ''}
            <p class="ann-card__body">${esc(a.body)}</p>
            ${rsvpHtml(a, myRsvpMap[a.id])}
          </article>`).join('')
        : `<div class="notices-empty">
            <span class="material-symbols-outlined notices-empty__icon">campaign</span>
            <div class="notices-empty__title">No notices posted yet</div>
            <div class="notices-empty__sub">Management will post building notices, AGM updates, and maintenance alerts here.</div>
          </div>`;

      // Attach RSVP button handlers.
      list.querySelectorAll('.ann-rsvp').forEach(rsvpEl => {
        const annId    = rsvpEl.dataset.annId;
        const yesBtn   = rsvpEl.querySelector('.ann-rsvp__yes');
        const noBtn    = rsvpEl.querySelector('.ann-rsvp__no');
        const countEl  = rsvpEl.querySelector('.ann-rsvp__count');
        const numInput = rsvpEl.querySelector('.ann-rsvp__num');
        const statusEl = rsvpEl.querySelector('.ann-rsvp__status');

        if (rsvpEl.dataset.closed) return;
        const submitBtn = rsvpEl.querySelector('.ann-rsvp__submit');
        let pendingResponse = myRsvpMap[annId]?.response || null;

        function selectResponse(response) {
          pendingResponse = response;
          if (yesBtn)  yesBtn.classList.toggle('ann-rsvp__active', response === 'yes');
          if (noBtn)   noBtn.classList.toggle('ann-rsvp__active',  response === 'no');
          if (countEl) countEl.classList.toggle('ann-rsvp__hidden', response !== 'yes');
          if (submitBtn) {
            submitBtn.classList.remove('ann-rsvp__hidden');
            submitBtn.textContent = myRsvpMap[annId] ? 'Change my response' : 'Submit';
          }
        }

        async function doRsvp() {
          if (!pendingResponse) return;
          const attendee_count = pendingResponse === 'yes' ? (parseInt(numInput?.value) || 1) : 0;
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Please wait…'; }
          try {
            const r = await fetch('/api/rsvp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ announcement_id: annId, contact_id: member.contact_id, response: pendingResponse, attendee_count, resident_name: member.name, resident_unit: member.unit }),
            });
            const d = await r.json();
            if (d.success) {
              myRsvpMap[annId] = { response: pendingResponse, attendee_count: d.attendee_count };
              const c = d.attendee_count || 1;
              if (statusEl) statusEl.textContent = pendingResponse === 'yes' ? `You're attending${c > 1 ? ` with ${c - 1} guest${c - 1 !== 1 ? 's' : ''}` : ''}.` : "You're not attending.";
              if (submitBtn) submitBtn.textContent = 'Change my response';
            }
          } catch {}
          if (submitBtn) submitBtn.disabled = false;
        }

        yesBtn?.addEventListener('click',    () => selectResponse('yes'));
        noBtn?.addEventListener('click',     () => selectResponse('no'));
        submitBtn?.addEventListener('click', doRsvp);
      });
    }

    const dash = $('dashNotices');
    if (dash) {
      dash.innerHTML = items.length
        ? items.slice(0, 4).map(a => `<div class="booking-row"><div><div class="booking-facility">${a.pinned ? '<span class="material-symbols-outlined" style="font-size:0.875rem;vertical-align:-2px;color:var(--gold);font-variation-settings:\'FILL\' 1,\'wght\' 400,\'opsz\' 20">push_pin</span> ' : ''}${esc(a.title)}</div><div class="booking-time">${esc(a.category)} · ${a.eventAt ? esc(annWhen(a)) : esc(annDate(a.createdAt))}</div></div></div>`).join('')
        : '<div class="panel-empty">No notices.</div>';
    }

    const banner = $('noticeBanner');
    if (banner) {
      const pinned = items.find(a => a.pinned);
      if (pinned) {
        const snippet = pinned.body.length > 140 ? pinned.body.slice(0, 140) + '…' : pinned.body;
        banner.style.display = '';
        banner.innerHTML = `<div class="notice-banner"><span class="notice-banner-tag">Pinned</span><div class="notice-banner-text"><strong>${esc(pinned.title)}</strong> - ${esc(snippet)}</div></div>`;
      } else {
        banner.style.display = 'none';
      }
    }

    // ── Dashboard cards: Upcoming Event (Event category) + Maintenance Alert (Maintenance category) ──
    const now = new Date();
    // Soonest announcement of a category whose window hasn't ended yet (upcoming or in progress).
    function nextOf(slug) {
      return items
        .filter(a => a.eventAt && catSlug(a.category) === slug)
        .filter(a => new Date(a.eventEndAt || a.eventAt) >= now)
        .sort((x, y) => new Date(x.eventAt) - new Date(y.eventAt))[0] || null;
    }

    const ev = nextOf('event');
    if ($('upcomingEventTitle')) $('upcomingEventTitle').textContent = ev ? ev.title : 'No upcoming events';
    if ($('upcomingEventSub'))   $('upcomingEventSub').textContent   = ev ? annWhen(ev) : '';

    const mt = nextOf('maintenance');
    if ($('alertTitle')) $('alertTitle').textContent = mt ? mt.title : 'No active alerts';
    if ($('alertSub')) {
      const inProgress = mt && new Date(mt.eventAt) <= now;
      $('alertSub').textContent = mt ? (inProgress ? 'In progress · ' : '') + annWhen(mt) : '';
    }
  }

  // ── Payments (read-only history) ───────────────────────────────────────────────
  // Move is one payment: SGD 200 admin fee + SGD 2000 refundable deposit = SGD 2200.
  // On completion the SGD 2000 deposit is refunded (shown on the Deposit Refunded card).
  const MOVE_REFUNDABLE_DEPOSIT = 2000;
  const PAY_DEPOSITS = { bbq: 200, pool: 200, verandah: 600, move: 2200, default: 50 };
  // "Requested" is retired - a deposit is outstanding only while at "Deposit Pending".
  const DEPOSIT_STAGES = new Set(['Deposit Pending']);
  // Derive the facility key from a GHL opportunity name.
  function _facKeyFromOppName(name) {
    const s = (name || '').toLowerCase();
    if (s.includes('verandah')) return 'verandah';
    if (s.includes('bbq') || s.includes('barbeque') || s.includes('barbecue')) return 'bbq';
    if (s.includes('pool') || s.includes('swimming')) return 'pool';
    return null;
  }
  function _facilityTitle(key, itemName) {
    if (key === 'bbq')      return 'BBQ Pit';
    if (key === 'pool')     return 'Swimming Pool';
    if (key === 'verandah') return 'The Verandah';
    if (key === 'move') {
      const n = (itemName || '').toLowerCase();
      return n.includes('move out') ? 'Move Out' : 'Move In';
    }
    // Unknown key - extract the readable part before the first dash/em-dash in the GHL opp name.
    return (itemName || '').split(/\s*[ - \- - ]\s*/)[0].trim() || 'Facility Booking';
  }

  // Format a stored booking's date/slot/pax as "15 Jun 2026 · 2:00 PM · 10 pax".
  function _fmtBookingLine(dateISO, slot, pax) {
    const dateStr = dateISO
      ? new Date(dateISO + 'T00:00:00+08:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' })
      : '';
    const timeStr = (slot || '').split(' - ')[0].trim();
    const parts   = [dateStr, timeStr, pax ? pax + ' pax' : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  // Prefer the resident's own (clean) locally-stored booking data for the
  // date/time/pax line. Matches by facility key, then narrows by the date AND
  // slot start time carried in the opportunity name so the EXACT booking (and its
  // pax) is selected - never a different booking for the same facility. Returns
  // null when there's no confident local match.
  const _slotStartKey = slot => (slot || '').split(' - ')[0].trim().replace(/\s+/g, '').toUpperCase();
  function _localBookingDetail(key, item) {
    if (!key || key === 'default' || key === 'move') return null;
    let list = getBookings().filter(b => b.facilityKey === key);
    if (!list.length) return null;
    const name = item.name || '';
    const dm = /(\d{4}-\d{2}-\d{2})/.exec(name);
    const tm = /(\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(name);
    if (dm) { const sameDay = list.filter(b => b.date === dm[1]); if (sameDay.length) list = sameDay; }
    if (tm) {
      const want    = _slotStartKey(tm[1]);
      const sameSlot = list.filter(b => _slotStartKey(b.slot) === want);
      if (sameSlot.length) list = sameSlot;
    }
    // Only trust a local match that the opp name actually pinned to a date or time;
    // otherwise fall back to name parsing rather than guessing the wrong booking.
    if (!dm && !tm && list.length > 1) return null;
    const b = list[list.length - 1];
    return _fmtBookingLine(b.date, b.slot, b.pax);
  }

  // Extract booking date, time, pax from GHL opportunity item.
  // Checks customFields first, then falls back to parsing item.name.
  function _parseBookingDetails(item) {
    const cfs = item.customFields || [];
    const cf  = re => { const f = cfs.find(c => re.test(c.label || '')); return f ? (f.fieldValueString || '') : ''; };
    let date = cf(/\bdate\b/i);
    let time = cf(/\btime\b|\bslot\b/i);
    let pax  = cf(/\bpax\b|\bguests?\b|\battendees?\b|\bnumber.?of/i);
    if (!date) { const m = /(\d{4}-\d{2}-\d{2})/.exec(item.name || ''); if (m) date = m[1]; }
    if (!time) { const m = /(\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s*[ - \-]\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/.exec(item.name || ''); if (m) time = m[1].trim(); }
    if (!pax)  { const m = /·\s*(\d+)\s*pax/i.exec(item.name || ''); if (m) pax = m[1]; }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = new Date(date + 'T00:00:00+08:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
    }
    const parts = [date, time, pax ? pax + ' pax' : ''].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    if (item.createdAt) return new Date(item.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
    return null;
  }


  // paidFeeSet: Set of "${oppId}_${feeLabel}" keys from DB payment records.
  function _renderPayCard(item, type, isPending, paidFeeSet = new Set()) {
    let key, amount;
    if (type === 'facility') {
      key    = _facKeyFromOppName(item.name) || 'default';
      amount = PAY_DEPOSITS[key] || PAY_DEPOSITS.default;
    } else {
      key    = 'move';
      amount = PAY_DEPOSITS.move;
    }
    const isVerandah = key === 'verandah';
    const amtStr     = `SGD ${Number(amount).toFixed(2)}`;
    const title      = _facilityTitle(key, item.name);
    // Prefer clean local booking data; fall back to parsing the opportunity name.
    const details    = _localBookingDetail(key, item) || _parseBookingDetails(item);
    const rawLabel   = esc(item.name || (type === 'facility' ? 'Facility Booking' : 'Move In / Out'));
    // Two-line header used by all card variants.
    const headerHtml = `<div class="pay-facility-title">${esc(title)}</div>${details ? `<div class="pay-facility-detail">${esc(details)}</div>` : ''}`;

    // ── Verandah pending: two separate fee rows ────────────────────────────────
    if (isPending && isVerandah) {
      const feeRows = VERANDAH_FEES.map(fee => {
        const isPaid = paidFeeSet.has(`${item.id}_${fee.feeLabel}`);
        return `<div class="pay-fee-row">
          <span class="pay-fee-row__name">${esc(fee.label)}</span>
          <div class="pay-fee-row__right">
            <span class="pay-fee-row__amt">SGD ${fee.amount.toFixed(2)}</span>
            ${isPaid
              ? '<span class="pay-tag paid">paid</span>'
              : `<button class="pay-pay-btn"
                   data-pay-key="verandah"
                   data-fee-label="${esc(fee.feeLabel)}"
                   data-fee-amount="${fee.amount}"
                   data-opp-id="${esc(item.id)}"
                   data-desc="${rawLabel}">Pay</button>`}
          </div>
        </div>`;
      }).join('');
      return `<div class="pay-due pay-due--verandah">
        <div class="pay-due__body">${headerHtml}</div>
        ${feeRows}
      </div>`;
    }

    // ── All other pending deposits ─────────────────────────────────────────────
    if (isPending) {
      return `<div class="pay-due">
        <div class="pay-due__body">${headerHtml}</div>
        <div class="pay-due__right">
          <div class="pay-due__amt">${esc(amtStr)}</div>
          <button class="pay-pay-btn" data-pay-key="${esc(key)}" data-opp-id="${esc(item.id)}" data-amount="${Number(amount).toFixed(2)}" data-desc="${rawLabel}"${!PAY_LINKS[key] ? ' disabled title="No payment link configured"' : ''}>Pay Deposit</button>
        </div>
      </div>`;
    }

    // ── History: Confirmed (paid) or Deposit Refunded ──────────────────────────
    const isRefunded = item.stage === 'Deposit Refunded';
    const baseMeta   = isVerandah ? 'Booking Fee + Refundable Deposit'
                     : key === 'move' ? 'Admin Fee + Refundable Deposit'
                     : 'Deposit';
    // Only the refundable deposit is returned on a move refund (admin fee is non-refundable).
    const histMeta   = isRefunded
                     ? (key === 'move' ? 'Refundable Deposit · Refunded' : `${baseMeta} · Refunded`)
                     : `${baseMeta} · Confirmed`;
    const histAmtStr = (isRefunded && key === 'move')
                     ? `SGD ${Number(MOVE_REFUNDABLE_DEPOSIT).toFixed(2)}`
                     : amtStr;
    const tagHtml    = isRefunded ? '<span class="pay-tag refunded">refunded</span>' : '<span class="pay-tag paid">paid</span>';
    return `<div class="pay-card">
      <div class="pay-card__body">
        ${headerHtml}
        <div class="pay-card__meta">${histMeta}</div>
      </div>
      <div class="pay-card__right">
        <div class="pay-card__amt">${esc(histAmtStr)}</div>
        ${tagHtml}
      </div>
    </div>`;
  }

  // pending/confirmed/refunded are arrays of [item, type] tuples ('facility' | 'move').
  // Payment History shows paid (Confirmed/Completed) AND Deposit Refunded records - // the latter mainly move-in/out deposits returned after the move completes.
  function _renderPayBlock(pending, confirmed, refunded, paidFeeSet = new Set()) {
    const historyCount = confirmed.length + refunded.length;
    if (!pending.length && !historyCount)
      return '<div class="panel-empty" style="padding:16px">No records yet.</div>';
    let html = '';
    if (pending.length) {
      html += '<div class="pay-sub-head">Pending Deposit</div>';
      html += pending.map(([item, type]) => _renderPayCard(item, type, true, paidFeeSet)).join('');
    } else {
      html += '<div class="panel-empty" style="padding:0 0 14px">No pending deposits.</div>';
    }
    if (historyCount) {
      html += `<button class="pay-history-toggle" onclick="var b=this.nextElementSibling;b.hidden=!b.hidden;this.querySelector('.phi').textContent=b.hidden?'▸':'▾'">
        <span>Payment History (${historyCount})</span><span class="phi">▾</span>
      </button>
      <div class="pay-history-body">`;
      if (confirmed.length) {
        html += `<div class="pay-sub-head" style="margin-top:12px">Confirmed</div>
          ${confirmed.map(([item, type]) => _renderPayCard(item, type, false, paidFeeSet)).join('')}`;
      }
      if (refunded.length) {
        html += `<div class="pay-sub-head" style="margin-top:12px">Deposit Refunded</div>
          ${refunded.map(([item, type]) => _renderPayCard(item, type, false, paidFeeSet)).join('')}`;
      }
      html += `</div>`;
    }
    return `<div style="padding:12px 16px 14px">${html}</div>`;
  }

  // The payment runs in the modal's secure iframe. We deliberately do NOT poll or
  // auto-close it while it's open: a background poll used to close the window
  // mid-payment (any transient fetch error made it look like the booking had left
  // Deposit Pending). The resident stays in control - they close it themselves, or
  // tap "I've Completed Payment" to confirm (see confirmCurrentPayment).
  const _isPayModalOpen = () => !!$('payModal') && $('payModal').classList.contains('open');
  let _payPoll = null;
  function _stopPayPoll() {
    if (_payPoll) { clearInterval(_payPoll); _payPoll = null; }
  }

  let _payCtx = null;
  function openPayModal(url, title, oppId, feeLabel, payKey, desc) {
    const m = $('payModal'); if (!m) return;
    _payCtx = { oppId: oppId || '', feeLabel: feeLabel || '', payKey: payKey || '', desc: desc || '' };
    $('payModalTitle').textContent = title || 'Pay Deposit';
    $('payFrame').src = prefillLink(url);
    m.classList.add('open');
  }
  function closePayModal() {
    _stopPayPoll();
    const m = $('payModal'); if (m) m.classList.remove('open');
    const f = $('payFrame'); if (f) f.removeAttribute('src');
  }
  // The resident pays inside the secure payment-link window, then taps "I've Completed
  // Payment" to confirm. That advances their OWN booking to Confirmed and records the
  // payment (the server verifies the booking belongs to them). Just CLOSING the dialog
  // (✕ / tapping outside) never confirms - it only refreshes the view.
  async function confirmCurrentPayment() {
    const ctx = _payCtx;
    _payCtx = null;
    _stopPayPoll();
    const btn  = $('payDoneBtn');
    const orig = btn ? btn.textContent : '';
    if (ctx && ctx.oppId) {
      if (btn) { btn.disabled = true; btn.textContent = 'Confirming…'; }
      try {
        const body = {
          pipeline:       ctx.payKey === 'move' ? 'move' : 'facility',
          opportunity_id: ctx.oppId,
          facility_key:   ctx.payKey || '',
          description:    ctx.desc || '',
        };
        if (ctx.feeLabel) body.fee_label = ctx.feeLabel;
        const r = await fetch('/api/payments/pay-deposit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (d.success) toast('Payment confirmed - your booking is now confirmed.', 'ok');
        else           toast(d.message || 'Could not confirm your payment. Please try again.', 'err');
      } catch {
        toast('Connection error confirming your payment. Please try again.', 'err');
      }
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
    closePayModal();
    loadPayments();
  }
  if ($('payModal')) {
    $('payModalClose').addEventListener('click', () => { _stopPayPoll(); _payCtx = null; closePayModal(); loadPayments(); });
    $('payModal').addEventListener('click', e => { if (e.target === $('payModal')) { _stopPayPoll(); _payCtx = null; closePayModal(); loadPayments(); } });
    $('payDoneBtn').addEventListener('click', confirmCurrentPayment);
  }

  async function loadPayments() {
    const el = $('payContainer');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) {
      el.innerHTML = '<div class="panel-empty">Please log out and back in to view payments.</div>';
      return;
    }
    const qs = new URLSearchParams();
    if (member.contact_id) qs.set('contact_id', member.contact_id);
    if (member.email)      qs.set('email', member.email);
    try {
      const [bRes, mRes, pRes] = await Promise.all([
        // Facility bookings come from /api/booking/mine (appointment-based, resident-
        // scoped, with the live opp stage + oppId). This is the same source My Bookings
        // uses, so a booking that shows there/in the pipeline also shows here.
        fetch(`/api/booking/mine?${qs.toString()}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/opportunities?pipeline=move&${qs.toString()}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/payments/mine?${qs.toString()}`).then(r => r.json()).catch(() => ({})),
      ]);
      // Build set of "oppId_feeLabel" for fees already recorded in DB.
      const paidFeeSet = new Set(
        (pRes.payments || [])
          .filter(p => p.opportunity_id && p.fee_label)
          .map(p => `${p.opportunity_id}_${p.fee_label}`)
      );
      // Server is the source of truth (GHL/Mongo) - no localStorage. Deposit facilities
      // with a linked opportunity, named so the card can detect the facility + show details.
      const facItems = (bRes.items || [])
        .filter(b => b.oppId)
        .map(b => ({ id: b.oppId, stage: b.stage, name: [b.facility || b.facilityKey, b.date, b.slot].filter(Boolean).join(' - ') }))
        .filter(o => _facKeyFromOppName(o.name));
      const moveItems = mRes.items || [];

      const pendingRaw = [
        ...facItems.filter(o => DEPOSIT_STAGES.has(o.stage)).map(o => [o, 'facility']),
        ...moveItems.filter(o => DEPOSIT_STAGES.has(o.stage)).map(o => [o, 'move']),
      ];
      const confirmed = [
        ...facItems.filter(o => o.stage === 'Confirmed' || o.stage === 'Completed').map(o => [o, 'facility']),
        ...moveItems.filter(o => o.stage === 'Confirmed' || o.stage === 'Completed').map(o => [o, 'move']),
      ];
      // Deposit Refunded (move-in/out deposits returned after the move) belongs in
      // Payment History too - only the move pipeline has this stage.
      const refunded = [
        ...moveItems.filter(o => o.stage === 'Deposit Refunded').map(o => [o, 'move']),
      ];
      // GHL's appointment workflow can spawn a DUPLICATE opportunity for the same
      // booking. After paying, one is Confirmed but the duplicate lingers at Deposit
      // Pending - drop any pending item whose booking (type + name) is already
      // confirmed, and collapse duplicate pendings to one.
      const bookingKey  = (o, t) => `${t}:${String(o.name || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
      // A booking that's already confirmed OR refunded shouldn't also show as pending.
      const historyKeys = new Set([...confirmed, ...refunded].map(([o, t]) => bookingKey(o, t)));
      const seenPending   = new Set();
      const pending = pendingRaw.filter(([o, t]) => {
        const k = bookingKey(o, t);
        if (historyKeys.has(k) || seenPending.has(k)) return false;
        seenPending.add(k);
        return true;
      });
      el.innerHTML = _renderPayBlock(pending, confirmed, refunded, paidFeeSet);
      el.querySelectorAll('[data-pay-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          let url, title, payLabel = '';
          const oppId    = btn.dataset.oppId    || '';
          const feeLabel = btn.dataset.feeLabel || '';
          const amt      = btn.dataset.feeAmount || btn.dataset.amount || '';
          if (feeLabel) {
            const fee = VERANDAH_FEES.find(f => f.feeLabel === feeLabel);
            if (fee) { url = fee.url; title = `Pay ${fee.label} - The Verandah`; payLabel = fee.label; }
          } else {
            const fees = PAY_LINKS[btn.dataset.payKey] || [];
            if (fees.length) { url = fees[0].url; title = 'Pay Deposit'; payLabel = fees[0].label; }
          }
          if (url) {
            // Pass the real amount + label so the demo checkout shows them.
            const q = new URLSearchParams();
            if (amt)      q.set('amount', amt);
            if (payLabel) q.set('label', payLabel);
            const qs = q.toString();
            if (qs) url += (url.includes('?') ? '&' : '?') + qs;
            openPayModal(url, title, oppId, feeLabel, btn.dataset.payKey || '', btn.dataset.desc || '');
          }
        });
      });
    } catch {
      el.innerHTML = '<div class="panel-empty">Could not load. Please try again.</div>';
      const hint = $('payLastUpdated');
      if (hint) hint.textContent = 'Failed to update';
      return;
    }
    const hint = $('payLastUpdated');
    if (hint) hint.textContent = 'Updated just now';
  }

  // ── Messages (resident ↔ management) - wired to the shared inbox design ─────────
  function msgQuery() {
    const qs = new URLSearchParams();
    if (member && member.contact_id) qs.set('contact_id', member.contact_id);
    if (member && member.email)      qs.set('email', member.email);
    return qs.toString();
  }
  function msgClock(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }) : '';
  }
  function msgDayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date(), yest = new Date(); yest.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Today';
    if (same(d, yest))  return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
  }
  function msgShort(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    return d.toDateString() === now.toDateString() ? msgClock(iso)
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Singapore' });
  }
  let _msgLastCount = -1;
  async function loadMessages() {
    const msgsEl = $('inboxMessages');
    const listEl = $('inboxList');
    if (!msgsEl || !member) return;
    const ix = $('memberInbox'); if (ix) ix.classList.add('inbox--thread-open');
    if (!member.contact_id && !member.email) { msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;text-align:center;padding:2rem;color:var(--text-2,#9a9088)">Please log out and back in to use messages.</div>'; return; }
    try {
      const res  = await fetch(`/api/messages/mine?${msgQuery()}`);
      const data = await res.json();
      const msgs = (data.success && data.messages) ? data.messages : [];
      // Thread bubbles with date separators (in = management, out = resident).
      if (!msgs.length) {
        msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;text-align:center;padding:2rem;color:var(--text-2,#9a9088)">No messages yet.<br>Send your first message to the management office below.</div>';
      } else {
        const unreadMgmt = (data.conversation && data.conversation.unread_management) || 0;
        let html = '', lastDay = '';
        msgs.forEach((m, i) => {
          const day = msgDayLabel(m.createdAt);
          if (day !== lastDay) { html += `<div class="inbox__date-sep"><span>${esc(day)}</span></div>`; lastDay = day; }
          const out = m.sender === 'resident';
          let statusIcon = '';
          if (out) {
            const hasReplyAfter = msgs.slice(i + 1).some(m2 => m2.sender !== 'resident');
            const isRead = hasReplyAfter || unreadMgmt === 0;
            statusIcon = isRead
              ? '<span class="msg-status msg-status--read material-symbols-outlined" title="Read">done_all</span>'
              : '<span class="msg-status msg-status--sent material-symbols-outlined" title="Sent">done</span>';
          }
          html += `<div class="inbox__msg inbox__msg--${out ? 'out' : 'in'}">
            <div class="inbox__msg-bubble">${esc(m.body)}</div>
            <div class="inbox__msg-time">${esc(msgClock(m.createdAt))}${statusIcon}</div>
          </div>`;
        });
        msgsEl.innerHTML = html;
        if (msgs.length !== _msgLastCount) { msgsEl.scrollTop = msgsEl.scrollHeight; _msgLastCount = msgs.length; }
      }
      // Single conversation entry in the list ("Management").
      if (listEl) {
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        const prev = last ? (last.sender === 'resident' ? 'You: ' : '') + last.body : 'Start a conversation with management';
        const resolved = data.conversation && data.conversation.resolved;
        listEl.innerHTML = `
          <div class="inbox__item active" data-convo-id="me" tabindex="0" role="button">
            <div class="inbox__item-avatar">M</div>
            <div class="inbox__item-body">
              <div class="inbox__item-row"><span class="inbox__item-name">Management</span><span class="inbox__item-time">${last ? esc(msgShort(last.createdAt)) : ''}</span></div>
              <div class="inbox__item-row"><span class="inbox__item-preview">${esc(prev)}</span>${resolved ? '<span class="inbox__item-status resolved">Resolved</span>' : ''}</div>
            </div>
          </div>`;
      }
      loadMsgBadge();
    } catch {
      msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;text-align:center;padding:2rem;color:var(--text-2,#9a9088)">Could not load messages. Please try again.</div>';
    }
  }
  async function loadMsgBadge() {
    const badge = $('msgBadge');
    if (!badge || !member || (!member.contact_id && !member.email)) return;
    try {
      const res  = await fetch(`/api/messages/unread?${msgQuery()}`);
      const data = await res.json();
      const n = (data.success && data.unread) ? data.unread : 0;
      if (n > 0) { badge.style.display = ''; badge.textContent = n > 9 ? '9+' : n; }
      else { badge.style.display = 'none'; }
    } catch {}
  }
  async function sendResidentMessage(body, onDone) {
    if (!member || !body || !body.trim()) return false;
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: member.contact_id, resident_email: member.email,
          resident_name: member.name, resident_unit: member.unit, body: body.trim(),
        }),
      });
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not send your message.', 'err'); return false; }
      await loadMessages();
      if (onDone) onDone();
      return true;
    } catch {
      toast('Connection error. Please try again.', 'err');
      return false;
    }
  }
  if ($('inboxBackBtn')) {
    $('inboxBackBtn').addEventListener('click', () => {
      const ix = $('memberInbox'); if (ix) ix.classList.remove('inbox--thread-open');
    });
  }
  // Compose bar (teammate's design IDs).
  if ($('inboxSendBtn') && $('inboxCompose')) {
    const ta = $('inboxCompose'), btn = $('inboxSendBtn');
    const fire = async () => {
      const body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      const ok = await sendResidentMessage(body);
      if (ok) { ta.value = ''; ta.style.height = 'auto'; }
      btn.disabled = false;
      ta.focus();
    };
    btn.addEventListener('click', fire);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } });
  }
  // New-conversation modal send (subject is folded into the message).
  if ($('inboxModalSend')) {
    $('inboxModalSend').addEventListener('click', async () => {
      const subj = $('newConvoSubject') ? $('newConvoSubject').value.trim() : '';
      const body = $('newConvoMsg') ? $('newConvoMsg').value.trim() : '';
      if (!body) { if ($('newConvoMsg')) $('newConvoMsg').focus(); return; }
      const full = subj ? `${subj}\n\n${body}` : body;
      const btn = $('inboxModalSend'); btn.disabled = true;
      const ok = await sendResidentMessage(full, () => {
        const modal = $('inboxNewModal'); if (modal) modal.style.display = 'none';
        if ($('newConvoSubject')) $('newConvoSubject').value = '';
        if ($('newConvoMsg')) $('newConvoMsg').value = '';
        toast('Message sent to management.');
      });
      btn.disabled = false;
      if (ok) navigate('messages');
    });
  }

  // ── Feedback helpers + other forms ─────────────────────────────────────────────
  let _t;
  function toast(msg, type) { const el = $('toast'); if (!el) return; el.textContent = msg; el.className = 'show ' + (type || 'ok'); clearTimeout(_t); _t = setTimeout(() => { el.className = ''; }, 3500); }

  function swalHtml(rows, body) {
    const cells = rows.map(([lbl, val]) =>
      `<div>
        <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:2px">${lbl}</div>
        <div style="color:#14110f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(val || ' - ')}</div>
      </div>`).join('');
    return `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:#3f3832">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px${body ? ';margin-bottom:14px' : ''}">${cells}</div>
      ${body ? `<div style="background:#faf7f2;border-radius:6px;padding:10px 12px">
        <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#312e81;font-weight:700;margin-bottom:3px">Details</div>
        <div style="color:#5a514a;font-size:0.82rem;line-height:1.5;white-space:pre-wrap">${esc(body)}</div>
      </div>` : ''}
    </div>`;
  }
  async function swalReview(title, rows, body) {
    if (!window.Swal) return { isConfirmed: true };
    return window.Swal.fire({
      title,
      html:               swalHtml(rows, body),
      showCancelButton:   true,
      confirmButtonText:  'Confirm &amp; Submit',
      cancelButtonText:   '&#8592; Edit Details',
      confirmButtonColor: '#312e81',
      cancelButtonColor:  '#9a9088',
      reverseButtons:     true,
      focusConfirm:       false,
    });
  }
  function swalDone(title, rows, body) {
    if (window.Swal) window.Swal.fire({ icon: 'success', title, html: swalHtml(rows, body), confirmButtonText: 'Got it', confirmButtonColor: '#312e81' });
    else toast(title);
  }
  function setMsg(id, t, err) { const el = $(id); if (el) { el.textContent = t; el.className = 'form-msg' + (err ? ' err' : ''); } }
  function clr(ids) { ids.forEach(id => { const el = $(id); if (el) el.value = ''; }); }

  // ── Inline field validation ──────────────────────────────────────────────────
  function fieldErr(id, msg) {
    const el = $(id); if (!el) return;
    let span = el.parentElement.querySelector('.inline-err');
    if (!span) { span = document.createElement('span'); span.className = 'inline-err'; el.after(span); }
    span.textContent = msg || '';
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validateInline() {
    // Guest form
    $('gVisitorType')?.addEventListener('change', () => fieldErr('gVisitorType', $('gVisitorType').value ? '' : 'Select a visitor type.'));
    $('gVisitorName')?.addEventListener('blur',   () => fieldErr('gVisitorName', $('gVisitorName').value.trim() ? '' : 'Visitor name is required.'));
    $('gVisitorEmail')?.addEventListener('blur',  () => { const v = $('gVisitorEmail').value.trim(); fieldErr('gVisitorEmail', !v ? 'Email is required.' : !EMAIL_RE.test(v) ? 'Enter a valid email address.' : ''); });
    $('gDate')?.addEventListener('blur',          () => fieldErr('gDate', $('gDate').value ? '' : 'Visit date is required.'));
    // Defect form
    $('dDesc')?.addEventListener('blur', () => fieldErr('dDesc', $('dDesc').value.trim() ? '' : 'Please describe the issue.'));
    // Move form
    $('moveDate')?.addEventListener('blur', () => fieldErr('moveDate', validateMoveDate($('moveDate').value)));
    $('moveTime')?.addEventListener('change', () => fieldErr('moveTime', $('moveTime').value ? '' : 'Please select a time slot.'));
    // Parcel form
    $('pcRef')?.addEventListener('blur', () => fieldErr('pcRef', $('pcRef').value.trim() ? '' : 'Parcel reference is required.'));
    // Feedback form
    $('fbDesc')?.addEventListener('blur', () => fieldErr('fbDesc', $('fbDesc').value.trim() ? '' : 'Description is required.'));
  }
  validateInline();

  // ── Move date validation helpers ──────────────────────────────────────────
  function calcMinMoveDate() {
    // Count 7 working days (Mon - Fri) forward from today SGT.
    const parts = todaySGT().split('-').map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    let count = 0;
    while (count < 7) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay(); // 0=Sun, 6=Sat
      if (dow !== 0 && dow !== 6) count++;
    }
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function validateMoveDate(dateStr) {
    if (!dateStr) return 'Please select a date.';
    const parts = dateStr.split('-').map(Number);
    const d   = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return 'Move In/Out is only permitted Monday to Friday.';
    if (dateStr < calcMinMoveDate()) return 'A minimum of 7 working days advance notice is required.';
    return '';
  }

  // Set move date min to earliest valid working day (7 working days ahead)
  const moveDateEl = $('moveDate');
  if (moveDateEl) {
    moveDateEl.min   = calcMinMoveDate();
    moveDateEl.value = '';
    moveDateEl.addEventListener('change', () => {
      const err = validateMoveDate(moveDateEl.value);
      fieldErr('moveDate', err);
    });
  }

  bind('moveSubmitBtn', async () => {
    const move_type = $('moveType').value;
    const move_date = $('moveDate').value;
    const move_time = $('moveTime').value;
    const notes     = $('moveNotes').value.trim();
    const moveDateErr = validateMoveDate(move_date);
    if (moveDateErr) { setMsg('moveMsg', moveDateErr, true); return; }
    if (!move_time) { setMsg('moveMsg', 'Please select a time slot.', true); return; }
    const { isConfirmed: mvOk } = await swalReview('Review Move Request', [
      ['Move Type', move_type || ''],
      ['Date',      fmtDate(move_date)],
      ['Time',      move_time],
      ['Unit',      member?.unit || ''],
    ], notes || null);
    if (!mvOk) return;
    const btn = $('moveSubmitBtn');
    setMsg('moveMsg', 'Submitting…'); btn.disabled = true;
    try {
      const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          move_type, move_date, move_time, notes,
          contact_id: member?.contact_id || '',
          name:       member?.name  || '',
          email:      member?.email || '',
          unit:       member?.unit  || '',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg('moveMsg', '');
        // Full submission is persisted server-side in MongoDB by POST /api/move.
        $('moveNotes').value = '';
        const mvPanel = $('myMovesList');
        if (mvPanel) mvPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
        setTimeout(() => loadMyMoves(), 3000);
        // Move-in/out needs a deposit - prompt to visit Payments tab.
        if (window.Swal) {
          window.Swal.fire({
            icon:               'success',
            title:              'Request Submitted!',
            html:               `Your <b>${esc(move_type || 'move')}</b> request is saved.<br><br>Pay your deposit anytime from the <b>Payments</b> tab.`,
            confirmButtonText:  'Go to Payments',
            showCancelButton:   true,
            cancelButtonText:   'Later',
            confirmButtonColor: '#312e81',
            cancelButtonColor:  '#9a9088',
          }).then(r => { if (r.isConfirmed) navigate('payments'); });
        } else {
          toast('Request submitted! Pay your deposit from the Payments tab.');
        }
      } else {
        setMsg('moveMsg', data.message || 'Submission failed.', true);
      }
    } catch { setMsg('moveMsg', 'Network error. Please try again.', true); }
    finally { btn.disabled = false; }
  });

  bind('gRegisterBtn', async () => {
    const visitorType    = $('gVisitorType').value;
    const name           = $('gVisitorName').value.trim();
    const email          = $('gVisitorEmail').value.trim();
    const phone          = $('gVisitorPhone').value.trim();
    const date           = $('gDate').value;
    const duration       = $('gDuration').value;
    const linkedBookingId = $('gLinkedBooking') ? $('gLinkedBooking').value : '';
    const linkedBooking  = linkedBookingId ? getBookings().find(b => b.id === linkedBookingId) : null;
    if (!visitorType) { setMsg('gMsg', 'Please select a visitor type.', true); return; }
    if (!name)        { setMsg('gMsg', 'Visitor name is required.', true); return; }
    if (!email)       { setMsg('gMsg', 'Visitor email is required.', true); return; }
    if (!date)        { setMsg('gMsg', 'Visit date is required.', true); return; }
    if (linkedBooking && linkedBooking.status !== 'Confirmed') {
      setMsg('gMsg', 'Please wait for your booking to be confirmed before registering guests for this event.', true);
      return;
    }
    const reviewRows = [
      ['Visitor Type', visitorType],
      ['Name',         name],
      ['Email',        email],
      ['Phone',        phone || ''],
      ['Visit Date',   fmtDate(date)],
      ['Duration',     duration],
    ];
    if (linkedBooking) reviewRows.push(['Linked Booking', `${linkedBooking.emoji || ''} ${linkedBooking.facilityName} · ${fmtDate(linkedBooking.date)}`]);
    const { isConfirmed: gOk } = await swalReview('Review Visitor Registration', reviewRows, null);
    if (!gOk) return;
    const btn = $('gRegisterBtn');
    setMsg('gMsg', 'Registering…'); btn.disabled = true;
    try {
      const res = await fetch('/api/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitor_type: visitorType, visitor_name: name, visitor_email: email, visitor_phone: phone,
          visit_date: date, duration,
          linked_booking_id: linkedBookingId || undefined,
          linked_facility:   linkedBooking ? linkedBooking.facilityName : undefined,
          linked_date:       linkedBooking ? linkedBooking.date         : undefined,
          host_name: member.name, host_email: member.email, host_unit: member.unit, host_contact_id: member.contact_id,
        }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('gMsg', data.message || 'Registration failed.', true); return; }
      setMsg('gMsg', '');
      swalDone('Visitor Registered', [
        ['Visitor',    name],
        ['Type',       visitorType],
        ['Visit Date', fmtDate(date)],
        ['Reference',  data.reference || ''],
      ], 'The guardhouse has been notified.' + (data.reference ? ` Pass ref: ${data.reference}.` : ''));
      $('gVisitorType').value = '';
      if ($('gLinkedBooking')) { $('gLinkedBooking').value = ''; updateGuestBookingStatus(); }
      clr(['gVisitorName', 'gVisitorEmail', 'gVisitorPhone']);
      const gPanel = $('myGuestsList');
      if (gPanel) gPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyGuests(), 3000);
    } catch {
      setMsg('gMsg', 'Something went wrong. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  bind('gResetBtn', () => { $('gVisitorType').value = ''; $('gLinkedBooking').value = ''; clr(['gVisitorName', 'gVisitorEmail', 'gVisitorPhone']); setMsg('gMsg', ''); updateGuestBookingStatus(); });
  if ($('gLinkedBooking')) $('gLinkedBooking').addEventListener('change', updateGuestBookingStatus);
  document.querySelectorAll('[data-view="guests"]').forEach(el => el.addEventListener('click', populateBookingSelector));

  // Show/hide urgency escalation notice based on radio selection
  if (document.querySelectorAll('input[name="dUrgency"]').length > 0) {
    document.querySelectorAll('input[name="dUrgency"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const urgencyMsg = $('dUrgencyMsg');
        if (radio.value !== 'Routine') {
          urgencyMsg.style.display = 'block';
        } else {
          urgencyMsg.style.display = 'none';
        }
      });
    });
  }

  bind('dSubmitBtn', async () => {
    const desc              = $('dDesc').value.trim();
    const location          = $('dLocation') ? $('dLocation').value : '';
    const category          = $('dCategory') ? $('dCategory').value : '';
    const secondaryCategory = $('dSecondaryCategory') ? $('dSecondaryCategory').value : '';
    const urgency           = document.querySelector('input[name="dUrgency"]:checked')?.value || 'Routine';
    if (!desc) { setMsg('dMsg', 'Please describe the issue.', true); return; }
    // Read attached photo as base64 data URL (if provided).
    let defect_file = '';
    const photoInput = $('dPhoto');
    if (photoInput && photoInput.files[0]) {
      const file = photoInput.files[0];
      setMsg('dMsg', 'Compressing photo…');
      defect_file = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = e => {
          const img = new Image();
          img.onerror = reject;
          img.onload = () => {
            const MAX = 1920;
            let { width, height } = img;
            if (width > MAX || height > MAX) {
              if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
              else                { width = Math.round(width * MAX / height); height = MAX; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
      setMsg('dMsg', '');
    }
    const catDisplay = secondaryCategory ? `${category} + ${secondaryCategory}` : category;
    const { isConfirmed: dOk } = await swalReview('Review Defect Report', [
      ['Category', catDisplay || ''],
      ['Urgency',  urgency  || ''],
      ['Location', location || ''],
      ['Unit',     member?.unit || ''],
    ], desc);
    if (!dOk) return;
    const btn = $('dSubmitBtn');
    setMsg('dMsg', 'Submitting…'); btn.disabled = true;
    try {
      const res = await fetch('/api/defect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, location, category, secondaryCategory, urgency, defect_file, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('dMsg', data.message || 'Submission failed.', true); return; }
      setMsg('dMsg', '');
      // Full submission is persisted server-side in MongoDB by POST /api/defect.
      swalDone('Report Submitted', [
        ['Category', catDisplay || ''],
        ['Urgency',  urgency  || ''],
        ['Location', location || ''],
        ['Unit',     member?.unit || ''],
      ], desc);
      clr(['dDesc']);
      $('dSecondaryCategory').value = '';
      if ($('dPhoto')) { $('dPhoto').value = ''; const n = $('dPhotoName'); if (n) { n.textContent = 'Choose a photo…'; n.classList.remove('has-file'); } }
      document.querySelector('input[name="dUrgency"][value="Routine"]').checked = true;
      $('dUrgencyMsg').style.display = 'none';
      const dfPanel = $('myDefects');
      if (dfPanel) dfPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyDefects(), 3000);
    } catch {
      setMsg('dMsg', 'Connection error. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  if ($('dPhoto')) {
    $('dPhoto').addEventListener('change', () => {
      const nameEl = $('dPhotoName');
      const file   = $('dPhoto').files[0];
      if (nameEl) {
        nameEl.textContent = file ? file.name : 'Choose a photo…';
        nameEl.classList.toggle('has-file', !!file);
      }
    });
  }
  bind('dCancelBtn', () => {
    clr(['dDesc']);
    setMsg('dMsg', '');
    $('dSecondaryCategory').value = '';
    if ($('dPhoto')) { $('dPhoto').value = ''; const n = $('dPhotoName'); if (n) { n.textContent = 'Choose a photo…'; n.classList.remove('has-file'); } }
    document.querySelector('input[name="dUrgency"][value="Routine"]').checked = true;
    $('dUrgencyMsg').style.display = 'none';
  });

  bind('pcSubmitBtn', async () => {
    const ref       = $('pcRef')       ? $('pcRef').value.trim()       : '';
    const courier   = $('pcCourier')   ? $('pcCourier').value.trim()   : '';
    const desc      = $('pcDesc')      ? $('pcDesc').value.trim()      : '';
    const collector = $('pcCollector') ? $('pcCollector').value.trim() : '';
    if (!ref) { setMsg('pcMsg', 'Please enter the parcel reference.', true); return; }
    const { isConfirmed: pcOk } = await swalReview('Notify Guardhouse', [
      ['Parcel Ref',          ref],
      ['Courier/Sender',      courier   || ''],
      ['Description',         desc      || ''],
      ['Authorized Collector', collector || ''],
      ['Unit',                member?.unit || ''],
    ], null);
    if (!pcOk) return;
    const btn = $('pcSubmitBtn');
    setMsg('pcMsg', 'Notifying…'); btn.disabled = true;
    try {
      const res = await fetch('/api/parcel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcel_reference: ref, courier, description: desc, authorized_collector: collector, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('pcMsg', data.message || 'Submission failed.', true); return; }
      if (data.duplicate) {
        setMsg('pcMsg', '');
        window.Swal?.fire({ icon: 'info', title: 'Already Logged', text: `Parcel reference "${ref}" is already on record with the guardhouse.`, confirmButtonText: 'OK', confirmButtonColor: '#312e81' });
        return;
      }
      setMsg('pcMsg', '');
      // Full submission is persisted server-side in MongoDB by POST /api/parcel.
      swalDone('Guardhouse Notified', [
        ['Parcel Ref',          ref],
        ['Courier/Sender',      courier   || ''],
        ['Authorized Collector', collector || ''],
        ['Unit',                member?.unit || ''],
      ], 'The guardhouse will receive and hold your parcel. Please collect it within 7 days.');
      clr(['pcRef', 'pcCourier', 'pcDesc', 'pcCollector']);
      const pcPanel = $('parcelList');
      if (pcPanel) pcPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyParcels(), 3000);
    } catch {
      setMsg('pcMsg', 'Connection error. Please try again.', true);
    } finally { btn.disabled = false; }
  });

  bind('fbSubmitBtn', async () => {
    const type     = $('fbType')     ? $('fbType').value     : '';
    const category = $('fbCategory') ? $('fbCategory').value : '';
    const desc     = $('fbDesc').value.trim();
    const fbDate   = $('fbDate') ? $('fbDate').value : '';
    const fbTime   = $('fbTime') ? $('fbTime').value : '';
    if (!desc) { setMsg('fbMsg', 'Please describe the incident.', true); return; }
    const { isConfirmed: fbOk } = await swalReview(`Review ${type || 'Submission'}`, [
      ['Type',     type     || ''],
      ['Category', category || ''],
      ['Date',     fbDate ? fmtDate(fbDate) : ''],
      ['Time',     fbTime  || ''],
    ], desc);
    if (!fbOk) return;
    const btn = $('fbSubmitBtn');
    setMsg('fbMsg', 'Submitting…'); btn.disabled = true;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, category, description: desc, incident_date: fbDate, incident_time: fbTime, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('fbMsg', data.message || 'Submission failed.', true); return; }
      setMsg('fbMsg', '');
      // Full submission is persisted server-side in MongoDB by POST /api/feedback.
      swalDone(`${type || 'Submission'} Received`, [
        ['Type',     type     || ''],
        ['Category', category || ''],
        ['Date',     fbDate ? fmtDate(fbDate) : ''],
        ['Unit',     member?.unit || ' - '],
      ], 'Thank you. Management will review your submission and respond shortly.');
      clr(['fbDesc', 'fbDate', 'fbTime']);
      const fbPanel = $('myFeedback');
      if (fbPanel) fbPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyFeedback(), 3000);
    } catch {
      setMsg('fbMsg', 'Connection error. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  bind('fbCancelBtn', () => { clr(['fbDesc', 'fbDate', 'fbTime']); setMsg('fbMsg', ''); });

  // ── Panel refresh buttons ────────────────────────────────────────────────────
  async function refreshPanel(btnId, loadFn) {
    const btn = $(btnId);
    if (btn) btn.classList.add('spinning');
    await loadFn();
    if (btn) btn.classList.remove('spinning');
  }
  bind('refreshGuests',  () => refreshPanel('refreshGuests',  loadMyGuests));
  bind('refreshDefects', () => refreshPanel('refreshDefects', loadMyDefects));
  bind('refreshMoves',   () => refreshPanel('refreshMoves',   loadMyMoves));
  bind('refreshParcels', () => refreshPanel('refreshParcels', loadMyParcels));
  bind('refreshFeedback', () => refreshPanel('refreshFeedback', loadMyFeedback));
  bind('refreshPayments', () => refreshPanel('refreshPayments', loadPayments));

  // ── Resources ─────────────────────────────────────────────────────────────
  const CATEGORY_ICONS = {
    'By-Laws':         'gavel',
    'Fire Safety':     'local_fire_department',
    'Meeting Minutes': 'event_note',
    'Strata Title Plan': 'map',
    'Other':           'description',
  };

  async function loadResources(silent) {
    const container = $('resourcesContainer');
    if (!container) return;
    if (!silent) container.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const res  = await fetch('/api/resources');
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Failed to load resources.');
      const docs = data.resources || [];
      if (!docs.length) {
        container.innerHTML = '<div class="panel-empty">No documents have been uploaded yet.</div>';
        return;
      }
      // Group by category
      const groups = {};
      docs.forEach(d => {
        const cat = d.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(d);
      });
      container.innerHTML = Object.entries(groups).map(([cat, items]) => `
        <div class="res-group">
          <div class="res-group-header">
            <span class="material-symbols-outlined res-group-icon">${esc(CATEGORY_ICONS[cat] || 'description')}</span>
            <span class="res-group-name">${esc(cat)}</span>
          </div>
          <div class="res-group-items">
            ${items.map(d => `
              <div class="res-item">
                <div class="res-item-info">
                  <span class="res-item-title">${esc(d.title)}</span>
                  <span class="res-item-meta">${esc(d.file_name)}${d.file_size ? ' · ' + _fmtSize(d.file_size) : ''}</span>
                </div>
                <button class="res-download-btn" data-res-id="${esc(d.id)}" data-file-name="${esc(d.file_name)}" data-file-type="${esc(d.file_type)}">
                  <span class="material-symbols-outlined">download</span> Download
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');
      // Attach download handlers
      container.querySelectorAll('.res-download-btn').forEach(btn => {
        btn.addEventListener('click', () => _downloadResource(btn.dataset.resId, btn.dataset.fileName, btn.dataset.fileType, btn));
      });
    } catch (err) {
      container.innerHTML = `<div class="panel-empty">${esc(err.message)}</div>`;
    }
  }

  async function _downloadResource(id, fileName, fileType, btn) {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Downloading…';
    try {
      const res  = await fetch(`/api/resources/${encodeURIComponent(id)}/download`);
      const data = await res.json();
      if (!data.success || !data.file_data) throw new Error(data.message || 'Download failed.');
      _triggerDownload(data.file_data, data.file_name || fileName, data.file_type || fileType);
    } catch (err) {
      alert('Download failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  function _triggerDownload(base64DataUrl, fileName, mimeType) {
    // base64DataUrl may be a full data URL or raw base64; handle both.
    let url;
    if (base64DataUrl.startsWith('data:')) {
      url = base64DataUrl;
    } else {
      url = `data:${mimeType || 'application/octet-stream'};base64,${base64DataUrl}`;
    }
    const a = document.createElement('a');
    a.href     = url;
    a.download = fileName || 'document';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function _fmtSize(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  bind('logoutBtn', () => { authToken = null; [SESS, TOKEN_KEY, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); }); window.location.href = 'index.html'; });

  // ── Mobile sidebar toggle ────────────────────────────────────────────────
  const _sidebar  = document.querySelector('.sidebar');
  const _overlay  = $('sbOverlay');
  function openSidebar()  { _sidebar.classList.add('sidebar--open'); _overlay.classList.add('sidebar__overlay--open'); document.body.style.overflow = 'hidden'; }
  function closeSidebar() { _sidebar.classList.remove('sidebar--open'); _overlay.classList.remove('sidebar__overlay--open'); document.body.style.overflow = ''; }
  bind('sbToggle', openSidebar);
  if (_overlay) _overlay.addEventListener('click', closeSidebar);
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => { if (window.innerWidth < 768) closeSidebar(); }));

  function bind(id, h) { const el = $(id); if (el) el.addEventListener('click', h); }

  // Restore an existing session and boot the portal LAST - after every top-level
  // declaration above is initialized - so bootPortal() can safely read them.
  try { member = JSON.parse(sessionStorage.getItem(SESS) || localStorage.getItem(SESS) || 'null'); } catch {}
  authToken = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || null;
  // A stored session with no token predates auth (or was cleared) - force a fresh
  // login so the portal gets a valid token rather than 401-looping on every call.
  if (member && authToken) bootPortal();
  else if (member && !authToken) { [SESS, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); }); }

})();
