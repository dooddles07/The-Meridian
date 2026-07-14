(function () {
  'use strict';

  // portal.controller.js  (served at /js/portal.controller.js)
  // Client-side controller for portal.html.
  // Login authenticates against POST /api/auth/resident/login. Every feature is
  // real (Mongo/Stripe-backed).

  const SESS = 'lumina_member';
  const $ = id => document.getElementById(id);
  // Finished bookings (no longer active): shown in history but excluded from the
  // active count, per-day limit, slot re-booking guard and guest linking.
  const FINISHED_STATUSES = ['Completed', 'No-Show', 'Cancelled'];
  const isFinished = s => FINISHED_STATUSES.includes(s);

  // Authenticated fetch
  // The resident session lives in an httpOnly cookie (set by the server on
  // login/signup) - client-side JS never sees or stores the token itself, so
  // there's nothing to attach here; the browser sends the cookie automatically
  // on every same-origin request. Shadowing the global fetch is still needed for
  // the 401 -> force-relogin handling below.
  const _rawFetch = window.fetch.bind(window);
  function fetch(url, opts = {}) {
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
    _rawFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'resident' }) }).catch(() => {}); // clear the cookie server-side
    [SESS, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    _broadcastLogout();
    window.location.reload();
  }

  // Cross-tab logout sync. Without this, logging out in one tab only clears the
  // server-side cookie - a second tab open to the same account keeps showing the
  // portal until its own next API call happens to 401, which can take up to a
  // minute since background tabs throttle timers. The `storage` event fires in
  // every OTHER same-origin tab the instant one tab writes to localStorage (and
  // never in the tab that wrote it), so it's an immediate, no-polling signal.
  function _broadcastLogout() {
    try { localStorage.setItem('lumina_logout_broadcast', String(Date.now())); } catch {}
  }
  window.addEventListener('storage', (e) => {
    if (e.key !== 'lumina_logout_broadcast' || !e.newValue) return;
    if (!sessionStorage.getItem(SESS) && !localStorage.getItem(SESS)) return; // this tab isn't logged in anyway
    [SESS, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    window.location.reload();
  });

  // Theme toggle
  (function initTheme() {
    const KEY = 'lumina-portal-theme';
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

  // Facility catalogue
  // variableDuration: true facilities let residents pick how many hours to book
  // (in exact 1-hour multiples, bounded by closing time) - Pool/Tennis/Squash/
  // Basketball/Gym/Fitness. BBQ and Verandah stay a single fixed-length block
  // (3h / 4h) since their deposit pricing and Verandah's "2 blocks/day" cap are
  // already built around one fixed session per booking.
  const FACILITIES = [
    { key: 'pool',       name: 'Swimming Pool',    emoji: '🏊', deposit: true, variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 5,  capacity: 'Max 4 guests / unit',  note: 'Children under 12 must be accompanied by an adult resident.',  notePlaceholder: 'e.g. Bringing 2 young children, all are supervised adults present' },
    { key: 'tennis',     name: 'Tennis Court',     emoji: '🎾', variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 4,  capacity: 'Max 3 guests',          note: 'Proper non-marking footwear required on court.',               notePlaceholder: 'e.g. Singles match, bringing own rackets and balls' },
    { key: 'squash',     name: 'Squash Court',     emoji: '🥎', variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 4,  capacity: 'Max 3 guests',          note: 'Non-marking shoes only. Eyewear recommended.',                 notePlaceholder: 'e.g. Friendly doubles game, please check front wall marker condition' },
    { key: 'basketball', name: 'Basketball Court', emoji: '🏀', variableDuration: true, open: 8,  close: 23, slot: 1, maxPax: 12, capacity: 'Max 12 occupants',       note: 'Half-court sharing may apply at peak hours.',                  notePlaceholder: 'e.g. 5-on-5 full court game, need ball pump available at guardhouse' },
    { key: 'gym',        name: 'Gymnasium',        emoji: '🏋️', variableDuration: true, open: 6,  close: 23, slot: 1, maxPax: 1,  capacity: 'Residents only',        note: 'No guests. Minimum age 16. Wipe down equipment after use.',    notePlaceholder: 'e.g. Need squat rack and bench press available, please check cable machine condition' },
    { key: 'fitness',    name: 'Fitness Room',     emoji: '🤸', variableDuration: true, open: 6,  close: 23, slot: 1, maxPax: 1,  capacity: 'Residents only',        note: 'Studio / yoga space. No guests permitted.',                    notePlaceholder: 'e.g. Yoga session, please have mats and blocks set out in advance' },
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

  // Fetch already-booked ranges (SGT minutes) for a facility/date from MongoDB
  // (the real source of truth - booking.controller.js), reflecting EVERY
  // resident's bookings. Returns null (not []) on a genuine fetch/parse
  // failure so callers can tell "confirmed nothing busy" apart from "couldn't
  // check" - rendering every slot as bookable on a failed check would let a
  // resident submit a booking that was never actually verified against the
  // real availability, only rejected later if the server happens to conflict.
  async function fetchBusyRanges(facilityKey, date, excludeId) {
    try {
      let url = `/api/booking/availability?facilityKey=${encodeURIComponent(facilityKey)}&date=${encodeURIComponent(date)}`;
      if (excludeId) url += `&exclude=${encodeURIComponent(excludeId)}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!data || !data.success) return null;
      return data.busy || [];
    } catch { return null; }
  }

  // Neither the calendar's native min/max nor a typed-in date get a second
  // check anywhere else client-side - this is that check, shared by the slot
  // grid (so an out-of-bounds date shows a clear error instead of a full
  // grid of pills that would only fail at submit) and confirmBooking (the
  // actual submit-time backstop).
  function _dateBoundsError(f, dateVal) {
    const today = todaySGT();
    if (!dateVal || dateVal < today) return 'Please choose a valid date.';
    if (f.maxAdvanceDays) {
      const maxDate = addDays(today, f.maxAdvanceDays);
      if (dateVal > maxDate) return `${f.name} can only be booked up to ${f.maxAdvanceDays} days in advance.`;
    }
    return null;
  }

  // Dispatches to the fixed-duration picker (BBQ/Verandah - one pill IS the
  // whole booking) or the variable-duration picker (the other 6 - start time
  // + a separate hours picker) depending on the facility.
  async function refreshSlots(f) {
    return f.variableDuration ? _refreshVariableSlots(f) : _refreshFixedSlots(f);
  }

  // Rebuild the start-time pill grid for the selected date - disables past
  // times (today) AND any start time overlapping an already-confirmed booking
  // (from the server). Duration is fixed per facility (f.slot hours), so
  // picking a start time is all residents ever choose - the end time (and the
  // wire-format "H:MM AM - H:MM AM" slot string the backend already expects)
  // is derived automatically, same contract as before, just a nicer picker.
  async function _refreshFixedSlots(f) {
    const dateVal = $('bkDate') && $('bkDate').value;
    const grid    = $('bkSlotGrid');
    const hidden  = $('bkSlot');
    const hint    = $('bkSlotHint');
    if (!grid || !hidden) return;

    if (!dateVal) {
      grid.innerHTML = `<div class="bk-slot-empty">Select a date first</div>`;
      hidden.value = '';
      grid._busy = null;
      _updateSlotEnd('');
      if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = ''; }
      return;
    }

    const boundsErr = _dateBoundsError(f, dateVal);
    if (boundsErr) {
      grid.innerHTML = `<div class="bk-slot-empty">Choose a valid date to see time slots.</div>`;
      hidden.value = '';
      grid._busy = null;
      _updateSlotEnd('');
      if (hint) { hint.className = 'bk-slot-hint err'; hint.innerHTML = `⚠ ${esc(boundsErr)}`; }
      return;
    }

    const slots   = timeSlots(f);
    const isToday = dateVal === todaySGT();
    const nowMins = isToday ? nowSGTMins() : -1;
    const prevVal = hidden.value;

    grid.innerHTML = `<div class="bk-slot-empty">Checking availability…</div>`;
    if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = 'Checking availability…'; }

    const busy = await fetchBusyRanges(f.key, dateVal, _editing ? _editing.id : '');
    // Bail if the user changed the date while we were fetching (stale response).
    if (($('bkDate') && $('bkDate').value) !== dateVal) return;

    if (busy === null) {
      grid.innerHTML = `<div class="bk-slot-empty">Could not check availability.</div>`;
      hidden.value = '';
      grid._busy = null;
      _updateSlotEnd('');
      if (hint) { hint.className = 'bk-slot-hint err'; hint.innerHTML = '⚠ Could not check availability - please try a different date or reload.'; }
      return;
    }

    const overlaps = (start, end) => busy.some(b => start < b.end && end > b.start);

    let pastCount = 0, bookedCount = 0;
    let keepVal = '';
    if (prevVal) {
      const start = parseSlotStart(prevVal), end = parseSlotEnd(prevVal);
      const stillBad = (isToday && start <= nowMins) || overlaps(start, end);
      keepVal = stillBad ? '' : prevVal;
    }

    const pills = slots.map(s => {
      const start = parseSlotStart(s), end = parseSlotEnd(s);
      const past   = isToday && start <= nowMins;
      const booked = !past && overlaps(start, end);
      if (past)   pastCount++;
      if (booked) bookedCount++;
      const disabled  = past || booked;
      const startLabel = s.split(' - ')[0];
      const active     = s === keepVal;
      return `<button type="button" class="bk-slot-pill${active ? ' bk-slot-pill--active' : ''}" data-slot="${esc(s)}" ${disabled ? 'disabled' : ''} title="${booked ? 'Already booked' : ''}">${esc(startLabel)}</button>`;
    }).join('');

    grid.innerHTML = pills || '<div class="bk-slot-empty">No slots configured for this facility.</div>';
    // Stashed so confirmBooking's maxBlocksPerDay pre-check can use the same
    // venue-wide count the server enforces, instead of the resident's own
    // bookings only - see confirmBooking for why that mismatch mattered.
    grid._busy = busy;
    hidden.value = keepVal;
    _updateSlotEnd(keepVal);
    if (_editing && !keepVal && prevVal === _editing.slot && hint) {
      hint.className = 'bk-slot-hint bk-slot-hint--warn';
      hint.textContent = 'Your original slot is no longer available - please choose another.';
      return;
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
  // Small derived "Ends at HH:MM" line shown once a start time is picked -
  // the whole point of a fixed-duration-per-facility picker is that residents
  // never have to compute the end time themselves.
  function _updateSlotEnd(slotStr) {
    const el = $('bkSlotEnd');
    if (!el) return;
    el.textContent = slotStr ? `Ends at ${slotStr.split(' - ')[1]}` : '';
  }

  // Variable-duration picker (Pool/Tennis/Squash/Basketball/Gym/Fitness):
  // residents pick a START time, then a DURATION in exact multiples of the
  // facility's 1-hour unit - there is no free-choice end time, so a mismatched
  // "10:00 AM start, 8:30 AM end" combination is structurally impossible; the
  // wire-format slot string is only ever built from start + N whole hours.
  async function _refreshVariableSlots(f) {
    const dateVal   = $('bkDate') && $('bkDate').value;
    const startGrid = $('bkStartGrid');
    const durField  = $('bkDurationField');
    const durGrid   = $('bkDurationGrid');
    const hidden    = $('bkSlot');
    const hint      = $('bkSlotHint');
    if (!startGrid || !hidden) return;

    if (durField) durField.hidden = true;
    if (durGrid)  durGrid.innerHTML = '';
    hidden.value = '';
    _updateSlotEnd('');

    if (!dateVal) {
      startGrid.innerHTML = `<div class="bk-slot-empty">Select a date first</div>`;
      if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = ''; }
      return;
    }

    const boundsErr = _dateBoundsError(f, dateVal);
    if (boundsErr) {
      startGrid.innerHTML = `<div class="bk-slot-empty">Choose a valid date to see start times.</div>`;
      if (hint) { hint.className = 'bk-slot-hint err'; hint.innerHTML = `⚠ ${esc(boundsErr)}`; }
      return;
    }

    const isToday  = dateVal === todaySGT();
    const nowMins  = isToday ? nowSGTMins() : -1;
    const openMin  = f.open * 60;
    const closeMin = f.close * 60;
    const stepMin  = f.slotStep || 15;
    const unitMin  = f.slot * 60; // 60 for every variable-duration facility today

    startGrid.innerHTML = `<div class="bk-slot-empty">Checking availability…</div>`;
    if (hint) { hint.className = 'bk-slot-hint'; hint.innerHTML = 'Checking availability…'; }

    const busy = await fetchBusyRanges(f.key, dateVal, _editing ? _editing.id : '');
    if (($('bkDate') && $('bkDate').value) !== dateVal) return; // stale - date changed mid-fetch

    if (busy === null) {
      startGrid.innerHTML = `<div class="bk-slot-empty">Could not check availability.</div>`;
      if (hint) { hint.className = 'bk-slot-hint err'; hint.innerHTML = '⚠ Could not check availability - please try a different date or reload.'; }
      return;
    }

    // Legal starts: every stepMin minutes from open, as long as at least one
    // 1-hour unit fits before closing (longer durations are checked once a
    // start is actually picked, in _renderDurationOptions).
    const starts = [];
    for (let m = openMin; m + unitMin <= closeMin; m += stepMin) starts.push(m);

    let pastCount = 0, bookedCount = 0;
    const pills = starts.map(startMin => {
      const past      = isToday && startMin <= nowMins;
      const minBooked = !past && busy.some(b => startMin < b.end && (startMin + unitMin) > b.start);
      if (past)      pastCount++;
      if (minBooked) bookedCount++;
      const disabled = past || minBooked;
      return `<button type="button" class="bk-slot-pill" data-start="${startMin}" ${disabled ? 'disabled' : ''} title="${minBooked ? 'Already booked' : ''}">${esc(fmtMins(startMin))}</button>`;
    }).join('');
    startGrid.innerHTML = pills || '<div class="bk-slot-empty">No start times configured for this facility.</div>';
    // Stashed so the (synchronous) click handler can build duration options
    // without a second network round trip.
    startGrid._ctx = { busy, closeMin, unitMin };

    if (hint) {
      const avail = starts.length - pastCount - bookedCount;
      if (avail === 0) {
        hint.className = 'bk-slot-hint err';
        hint.innerHTML = isToday
          ? '⚠ No start times available today - please select a future date.'
          : '⚠ Fully booked - please select another date.';
      } else {
        hint.className = 'bk-slot-hint';
        const parts = [`<span class="bk-hint-ok">✓ ${avail} start times available</span>`];
        if (bookedCount) parts.push(`<span class="bk-hint-past">${bookedCount} booked</span>`);
        if (pastCount)   parts.push(`<span class="bk-hint-past">${pastCount} past</span>`);
        hint.innerHTML = parts.join(' &nbsp;·&nbsp; ');
      }
    }

    // Edit mode: try to restore the exact start + duration being edited by
    // simulating the same clicks a resident would make - reuses the normal
    // path instead of duplicating the selection logic.
    if (_editing) {
      const startMin = parseSlotStart(_editing.slot);
      const btn = startGrid.querySelector(`[data-start="${startMin}"]`);
      if (btn && !btn.disabled) {
        btn.click();
        const units = Math.round((parseSlotEnd(_editing.slot) - startMin) / unitMin);
        const durBtn = durGrid && durGrid.querySelector(`[data-units="${units}"]`);
        if (durBtn && !durBtn.disabled) {
          durBtn.click();
        } else if (hint) {
          hint.className = 'bk-slot-hint bk-slot-hint--warn';
          hint.textContent = 'Your original slot is no longer available - please choose another.';
        }
      } else if (hint) {
        hint.className = 'bk-slot-hint bk-slot-hint--warn';
        hint.textContent = 'Your original slot is no longer available - please choose another.';
      }
    }
  }

  // Builds the "N hour(s)" duration pills for the currently-selected start
  // time - each option's legality (fits before closing, doesn't overlap an
  // existing booking) is exact arithmetic on whole unitMin multiples, so a
  // partial-hour or past-closing duration can never even appear as a choice.
  function _renderDurationOptions(startMin) {
    const startGrid = $('bkStartGrid');
    const durField  = $('bkDurationField');
    const durGrid   = $('bkDurationGrid');
    if (!startGrid || !durGrid || !startGrid._ctx) return;
    const { busy, closeMin, unitMin } = startGrid._ctx;
    const maxUnits = Math.floor((closeMin - startMin) / unitMin);
    const pills = [];
    for (let n = 1; n <= maxUnits; n++) {
      const endMin   = startMin + n * unitMin;
      const conflict = busy.some(b => startMin < b.end && endMin > b.start);
      pills.push(`<button type="button" class="bk-slot-pill" data-units="${n}" ${conflict ? 'disabled' : ''} title="${conflict ? 'Overlaps an existing booking' : ''}">${n} hour${n === 1 ? '' : 's'}</button>`);
    }
    durGrid.innerHTML = pills.join('') || '<div class="bk-slot-empty">No durations fit before closing.</div>';
    if (durField) durField.hidden = false;
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
  // False until the first real /api/booking/mine fetch resolves - lets the
  // dashboard tell "haven't loaded yet" apart from "genuinely no bookings",
  // so it shows a Loading state instead of a false "No upcoming bookings" for
  // however long the initial fetch takes (worse on a cold Railway start).
  let _bookingsLoaded = false;
  let _noticesLoaded  = false;
  const getBookings  = () => _bookings;
  const saveBookings = list => { _bookings = Array.isArray(list) ? list : []; };  // optimistic; persistence is via the API
  let _myGuests = []; // latest /api/guest/mine items - used to count a booking's linked guests
  let _editingGuestId = null; // set while the guest form is editing an existing pass (vs creating)
  let _editingDefectId = null; // set while the defect form is editing an existing report
  let _editingFeedbackId = null; // set while the feedback form is editing an existing submission
  let _editingParcelId = null; // set while the parcel form is editing an existing notification
  // Read an image File, downscale to <=1920px, and return a compressed JPEG data
  // URL. Rejects on a read/decode failure so callers can show a photo-specific
  // error instead of a generic network one.
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = e => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode'));
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
  }


  // Session / login
  let member = null;
  // NOTE: restoring the session and auto-booting is deferred to the very end of
  // this IIFE (see bottom). bootPortal() reads top-level consts declared further
  // down (e.g. FB_CATEGORIES); calling it here would hit a temporal-dead-zone
  // "Cannot access 'FB_CATEGORIES' before initialization" error for returning
  // sessions. Everything must be initialized first.

  // Sign In / Register tab switch (WAI-ARIA tabs pattern: Left/Right moves focus + selection).
  const tabSignIn     = $('tabSignIn');
  const tabRegister   = $('tabRegister');
  const panelSignIn   = $('panelSignIn');
  const panelRegister = $('panelRegister');
  const PANEL_FOCUS = { signin: 'loginEmail', register: 'regName' };

  function showPanel(name) {
    panelSignIn.hidden   = name !== 'signin';
    panelRegister.hidden = name !== 'register';
    tabSignIn.classList.toggle('login-tab--active', name === 'signin');
    tabRegister.classList.toggle('login-tab--active', name === 'register');
    tabSignIn.setAttribute('aria-selected', String(name === 'signin'));
    tabRegister.setAttribute('aria-selected', String(name === 'register'));
    tabSignIn.tabIndex = name === 'signin' ? 0 : -1;
    tabRegister.tabIndex = name === 'register' ? 0 : -1;
    $(PANEL_FOCUS[name]).focus();
  }
  const selectTab = showPanel; // kept as an alias - existing call sites below say "selectTab"
  tabSignIn.addEventListener('click', () => showPanel('signin'));
  tabRegister.addEventListener('click', () => showPanel('register'));
  [tabSignIn, tabRegister].forEach(tab => {
    tab.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      showPanel(tab === tabSignIn ? 'register' : 'signin');
      (tab === tabSignIn ? tabRegister : tabSignIn).focus();
    });
  });

  // Password show/hide — shared by every [data-pw-toggle] button
  document.querySelectorAll('[data-pw-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.pwToggle);
      const show  = input.type === 'password';
      input.type  = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.querySelector('.material-symbols-outlined').textContent = show ? 'visibility_off' : 'visibility';
    });
  });

  // A real <form> now wraps this panel, so Enter-to-submit and native
  // required/type=email validation come from the browser for free.
  $('signInForm').addEventListener('submit', e => { e.preventDefault(); doLogin(); });

  async function doLogin() {
    const email    = $('loginEmail').value.trim().toLowerCase();
    const password = $('loginPassword').value;
    const errEl = $('loginErr');
    const btn   = $('loginBtn');
    if (!email || !password) { errEl.textContent = 'Please enter your email address and password.'; $('loginEmail').focus(); return; }
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const res  = await fetch('/api/auth/resident/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!data.success) { errEl.textContent = data.message || 'Invalid email or password.'; $('loginPassword').focus(); return; }
      member = data.member;
      // The session cookie is already set by the server on this same response -
      // nothing to store client-side beyond the (non-secret) display info below.
      _authExpiredHandled = false;
      sessionStorage.setItem(SESS, JSON.stringify(member));
      localStorage.setItem(SESS, JSON.stringify(member));
      bootPortal();
    } catch {
      errEl.textContent = 'Connection error. Please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Access Resident Portal';
    }
  }

  // Same real-<form> treatment as sign-in: Enter-to-submit + native validation
  // (required fields, type=email, minlength=8) come from the browser now.
  $('registerForm').addEventListener('submit', e => { e.preventDefault(); doSignup(); });

  let regResidentType = 'Owner';
  document.querySelectorAll('.login-segmented__opt').forEach(btn => {
    btn.addEventListener('click', () => {
      regResidentType = btn.dataset.regType;
      document.querySelectorAll('.login-segmented__opt').forEach(b => {
        const active = b === btn;
        b.classList.toggle('login-segmented__opt--active', active);
        b.setAttribute('aria-checked', String(active));
      });
    });
  });

  async function doSignup() {
    const name     = $('regName').value.trim();
    const unit     = $('regUnit').value.trim();
    const email    = $('regEmail').value.trim().toLowerCase();
    const password = $('regPassword').value;
    const confirm  = $('regConfirm').value;
    const errEl = $('signupErr');
    const btn   = $('signupBtn');
    if (!name || !unit || !email || !password) { errEl.textContent = 'Please fill in every field.'; return; }
    if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; $('regPassword').focus(); return; }
    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; $('regConfirm').focus(); return; }
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Creating account…';
    try {
      const res  = await fetch('/api/auth/resident/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, unit, email, password, residentType: regResidentType }),
      });
      const data = await res.json();
      if (!data.success) {
        errEl.textContent = data.message || 'Unable to create account.';
        if (/already exists/i.test(data.message || '')) {
          selectTab('signin');
          $('loginEmail').value = email;
          $('loginPassword').focus();
        }
        return;
      }
      member = data.member;
      // The session cookie is already set by the server on this same response -
      // nothing to store client-side beyond the (non-secret) display info below.
      _authExpiredHandled = false;
      sessionStorage.setItem(SESS, JSON.stringify(member));
      localStorage.setItem(SESS, JSON.stringify(member));
      bootPortal();
    } catch {
      errEl.textContent = 'Connection error. Please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Register My Unit';
    }
  }

  function bootPortal() {
    $('login-screen').style.display = 'none';
    $('portal-shell').style.display = 'block';
    $('loadingOverlay').classList.add('hidden');

    $('sbAvatar').textContent = (member.initials || 'R').toUpperCase();
    $('sbName').textContent   = member.name || 'Resident';
    $('sbUnit').textContent   = `Unit ${member.unit || ' - '}`;
    if ($('dashGreetName')) $('dashGreetName').textContent = (member.name || '').trim().split(/\s+/)[0] || 'Resident';
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
    // Live payments: refresh the panel while it's open so a payment confirmed
    // by the Stripe webhook (or a management action) shows up without a manual
    // reload. Paying itself navigates away to Stripe's own page (see
    // startStripeCheckout), so there's no in-page payment state this could interrupt.
    setInterval(() => {
      const v = $('view-payments');
      if (v && v.classList.contains('active')) {
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

  // View switching
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
  // Every [data-view] nav trigger (sidebar items, dashboard cards, quick-strip,
  // "→" panel links) is a plain <div> or href-less <a> - neither is focusable
  // or keyboard-activatable by default, so without this a keyboard-only or
  // screen-reader user can't navigate the app at all beyond the one they land
  // on. Skip anything already natively interactive (a real <button>, or an
  // <a> that already has an href) so we don't stomp on working behavior.
  document.querySelectorAll('[data-view]').forEach(el => {
    const activate = () => navigate(el.dataset.view);
    el.addEventListener('click', activate);
    const isNativelyInteractive = (el.tagName === 'A' && el.hasAttribute('href')) || el.tagName === 'BUTTON';
    if (isNativelyInteractive) return;
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });

  // Facility chooser
  function renderFacilities() {
    const grid = $('facilityGrid');
    if (!grid) return;
    grid.innerHTML = FACILITIES.map(f => `
      <div class="fac-card" data-fac="${f.key}" style="--fac-img:url('/assets/images/${f.key}.jpg')">
        <div class="fac-img-wrap">
          <div class="fac-img-overlay">Book Now</div>
        </div>
        <div class="fac-inner">
          <div class="fac-name">${esc(f.name)}</div>
          <div class="fac-row">
            <span class="fac-hours">${hoursLabel(f)}</span>
            <span class="fac-cap">${esc(f.capacity)}</span>
            ${f.deposit ? `<span class="fac-deposit-badge">USD ${(PAY_DEPOSITS[f.key] || 0).toFixed(0)} deposit</span>` : ''}
          </div>
        </div>
      </div>`).join('');
    grid.querySelectorAll('[data-fac]').forEach(el => el.addEventListener('click', () => openBooking(el.dataset.fac)));
  }

  // Booking modal
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
    // Editing never resets the deposit deadline (see booking.controller.js's
    // update()) - it's tied to when the slot was first held, not which slot is
    // currently chosen, so repeatedly editing can't be used to indefinitely
    // extend an unpaid hold. Surface that explicitly so it isn't a surprise.
    const depositNoteHtml = (_editing && _editing.status === 'Deposit Pending' && _editing.depositDueAt)
      ? `<div class="bk-rule bk-rule--warn">${esc(_depositCountdown(_editing.depositDueAt))} - editing does not extend this deadline. Pay from the Payments tab before it expires or this booking will be automatically cancelled.</div>`
      : '';
    // Shown upfront, before the resident ever commits - previously this only
    // appeared in the success dialog AFTER booking, which meant the deposit
    // requirement itself came as a surprise.
    const depositAmt = PAY_DEPOSITS[f.key] || 0;
    const refundablePart = REFUNDABLE_AMOUNTS[f.key];
    const depositDisclosureHtml = f.deposit
      ? `<div class="bk-deposit-disclosure">Requires a USD ${depositAmt.toFixed(2)} deposit${(refundablePart && refundablePart < depositAmt)
          ? ` - USD ${(depositAmt - refundablePart).toFixed(2)} non-refundable booking fee + USD ${refundablePart.toFixed(2)} refundable deposit`
          : ' (fully refundable)'}, paid within 24 hours after booking.</div>`
      : '';

    const slotFieldHtml = f.variableDuration
      ? `<div class="bk-field">
           <label>Start Time</label>
           <div class="bk-slot-grid" id="bkStartGrid"><div class="bk-slot-empty">Select a date first</div></div>
         </div>
         <div class="bk-field" id="bkDurationField" hidden>
           <label>Duration <span class="bk-field-note">(exact ${f.slot}-hour blocks)</span></label>
           <div class="bk-slot-grid" id="bkDurationGrid"></div>
         </div>`
      : `<div class="bk-field">
           <label>Time Slot <span class="bk-field-note">(${f.slot} hour${f.slot === 1 ? '' : 's'} - pick a start time)</span></label>
           <div class="bk-slot-grid" id="bkSlotGrid"><div class="bk-slot-empty">Select a date first</div></div>
         </div>`;

    host.innerHTML = `
      <div class="bk">
        <div class="bk-banner" style="--fac-img:url('/assets/images/${f.key}.jpg')">
          <div class="bk-banner-info">
            <div class="bk-banner-name">${esc(f.name)}</div>
            <div class="bk-banner-meta">Open ${hoursLabel(f)} &nbsp;·&nbsp; ${esc(f.capacity)}</div>
          </div>
        </div>
        ${depositDisclosureHtml}
        <div class="bk-form">
          ${depositNoteHtml}
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
          ${slotFieldHtml}
          <div class="bk-slot-end" id="bkSlotEnd"></div>
          <input type="hidden" id="bkSlot" />
          <div class="bk-slot-hint" id="bkSlotHint"></div>
          <div class="bk-rule">${esc(f.note)}</div>
          <div class="bk-field">
            <label>Notes (optional)</label>
            <textarea id="bkNotes" rows="2" placeholder="${esc(f.notePlaceholder)}"></textarea>
          </div>
          <div class="bk-err" id="bkErr"></div>
          <button class="bk-confirm" id="bkConfirm">${_editing ? 'Save Changes' : 'Confirm Booking'}</button>
        </div>
      </div>`;

    $('bkDate').addEventListener('change', () => refreshSlots(f));
    $('bkConfirm').addEventListener('click', () => confirmBooking());

    if (f.variableDuration) {
      $('bkStartGrid').addEventListener('click', (e) => {
        const btn = e.target.closest('.bk-slot-pill');
        if (!btn || btn.disabled) return;
        $('bkStartGrid').querySelectorAll('.bk-slot-pill--active').forEach(b => b.classList.remove('bk-slot-pill--active'));
        btn.classList.add('bk-slot-pill--active');
        $('bkSlot').value = '';
        _updateSlotEnd('');
        _renderDurationOptions(Number(btn.dataset.start));
        const hint = $('bkSlotHint');
        if (hint && hint.classList.contains('bk-slot-hint--warn')) { hint.className = 'bk-slot-hint'; hint.textContent = ''; }
      });
      $('bkDurationGrid').addEventListener('click', (e) => {
        const btn = e.target.closest('.bk-slot-pill');
        if (!btn || btn.disabled) return;
        $('bkDurationGrid').querySelectorAll('.bk-slot-pill--active').forEach(b => b.classList.remove('bk-slot-pill--active'));
        btn.classList.add('bk-slot-pill--active');
        const startBtn = $('bkStartGrid').querySelector('.bk-slot-pill--active');
        if (!startBtn) return;
        const startMin = Number(startBtn.dataset.start);
        const units    = Number(btn.dataset.units);
        const endMin   = startMin + units * (f.slot * 60);
        const slotStr  = `${fmtMins(startMin)} - ${fmtMins(endMin)}`;
        $('bkSlot').value = slotStr;
        _updateSlotEnd(slotStr);
      });
    } else {
      $('bkSlotGrid').addEventListener('click', (e) => {
        const btn = e.target.closest('.bk-slot-pill');
        if (!btn || btn.disabled) return;
        $('bkSlotGrid').querySelectorAll('.bk-slot-pill--active').forEach(b => b.classList.remove('bk-slot-pill--active'));
        btn.classList.add('bk-slot-pill--active');
        $('bkSlot').value = btn.dataset.slot;
        _updateSlotEnd(btn.dataset.slot);
        const hint = $('bkSlotHint');
        if (hint && hint.classList.contains('bk-slot-hint--warn')) { hint.className = 'bk-slot-hint'; hint.textContent = ''; }
      });
    }
    modal.classList.add('open');

    if (_editing) {
      $('bkPax').value   = _editing.pax || 1;
      $('bkNotes').value = _editing.notes || '';
      $('bkDate').value  = _editing.date;
      // Fixed-duration path restores selection via a seeded hidden value;
      // the variable-duration path reads _editing directly and re-simulates
      // the start+duration clicks itself (see _refreshVariableSlots).
      if (!f.variableDuration) $('bkSlot').value = _editing.slot;
      refreshSlots(f);
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
    const boundsErr = _dateBoundsError(f, date);
    if (boundsErr) { errEl.textContent = boundsErr; return; }
    if (!slot)  { errEl.textContent = 'Please choose a time slot.'; return; }
    if (date === todaySGT() && parseSlotStart(slot) <= nowSGTMins()) {
      errEl.textContent = 'That time slot has already passed. Please choose another.'; return;
    }
    if (isNaN(pax) || pax < 1 || pax > f.maxPax) {
      errEl.textContent = `Pax must be between 1 and ${f.maxPax}.`; return;
    }
    if (f.maxBlocksPerDay) {
      // Venue-wide, not just this resident's own bookings - matches the server's
      // own check (booking.controller.js's checkBlocksPerDay). grid._busy (stashed
      // by _refreshFixedSlots for the currently-selected date) already excludes
      // Cancelled bookings and the booking being edited, same as the server query.
      const grid = $('bkSlotGrid');
      if (grid && Array.isArray(grid._busy)) {
        const sameDayCount = grid._busy.length;
        if (sameDayCount >= f.maxBlocksPerDay) {
          errEl.textContent = `Maximum ${f.maxBlocksPerDay} block${f.maxBlocksPerDay > 1 ? 's' : ''} of ${f.name} may be booked per day.`; return;
        }
      }
      // If busy data isn't available yet, fail open here - the server's own
      // check (now applied on both create AND edit) is the real backstop.
    }

    errEl.textContent = '';

    // Step 1: Review before submitting. Falls back to the browser's native
    // confirm() if the SweetAlert CDN didn't load - a plain dialog beats
    // silently skipping the review/cancel gate entirely and submitting
    // straight through with no chance to back out.
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
    } else {
      const summary = `${editing ? 'Save changes to' : 'Book'} ${f.name} on ${fmtDate(date)}, ${slot}, ${pax} pax${notes ? ` (${notes})` : ''}?`;
      if (!window.confirm(summary)) return;
    }

    // Step 2: Submit
    btn.disabled    = true;
    btn.textContent = editing ? 'Saving…' : 'Confirming…';

    try {
      // Edit an existing booking
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

      // Create a new booking
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
      // "Deposit Pending" until the deposit is paid.
      // Store the opportunity id so the deposit modal can record per-fee payments
      // against the SAME opp the Payments tab reads from.
      list.push({ id: bookingId, oppId, facilityKey: f.key, facilityName: f.name, emoji: f.emoji, date, slot, pax, notes, ts: Date.now(), status: isDepositFacility(f.key) ? 'Deposit Pending' : 'Confirmed' });
      saveBookings(list);

      closeModal(); renderMyBookings(); renderDashboardBookings();
      syncBookingStatuses(); // reconcile with the server (Mongo) record

      if (isDepositFacility(f.key)) {
        const depositAmt = PAY_DEPOSITS[f.key] || PAY_DEPOSITS.default;
        const dueTxt = data.depositDueAt
          ? new Date(data.depositDueAt).toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' })
          : '';
        if (window.Swal) {
          window.Swal.fire({
            icon:               'success',
            title:              'Booking Saved!',
            html:               `Your <b>${esc(f.name)}</b> booking needs a <b>USD ${depositAmt.toFixed(2)}</b> deposit to be confirmed.<br><br>`
                               + `⚠ Pay within <b>24 hours</b>${dueTxt ? ` (by ${esc(dueTxt)})` : ''} or this booking will be automatically cancelled and the slot released.<br><br>`
                               + `Go to the <b>Payments</b> tab to pay now.`,
            confirmButtonText:  'Go to Payments',
            showCancelButton:   true,
            cancelButtonText:   'Later',
            confirmButtonColor: '#312e81',
            cancelButtonColor:  '#9a9088',
          }).then(r => { if (r.isConfirmed) navigate('payments'); });
        } else {
          toast(`Booking saved! Pay the USD ${depositAmt.toFixed(2)} deposit within 24 hours from the Payments tab.`);
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

  // Whether a facility/pipeline takes a deposit - DEPOSIT_FACILITY_KEYS (below,
  // server-driven) covers real facilities; 'move' is the one hand-added
  // exception since it isn't in the facility catalogue at all.
  function isDepositFacility(key) {
    const f = FACILITIES.find(x => x.key === key);
    return !!(f && f.deposit) || DEPOSIT_FACILITY_KEYS.has(key) || key === 'move';
  }
  function closeModal() { if (modal) { modal.classList.remove('open'); if (host) host.innerHTML = ''; } _editing = null; }
  if (modal) {
    bind('modalCloseBtn', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }

  // My Bookings
  const UPCOMING_STATUSES = ['Confirmed', 'Deposit Pending'];
  const isUpcoming = s => UPCOMING_STATUSES.includes(s);

  // Unpaid deposit bookings auto-cancel 24h after creation (see the backend's
  // expireStaleDeposits) - show the countdown so it isn't a silent surprise.
  function _depositCountdown(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'Payment window expired';
    const hrs  = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return hrs >= 1 ? `Pay within ${hrs}h ${mins}m` : `Pay within ${mins}m`;
  }

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
          const statusExtra = b.status === 'Deposit Pending' && b.depositDueAt
            ? `<div class="bk-deposit-countdown">${esc(_depositCountdown(b.depositDueAt))}</div>`
            : (b.status === 'Cancelled' && b.cancelReason === 'deposit_expired'
                ? `<div class="bk-expired-note">Deposit window expired</div>`
                : '');
          const row = `<tr><td>${b.emoji} ${esc(b.facilityName)}</td><td style="font-size:0.8rem">${fmtDate(b.date)}</td><td style="font-size:0.8rem">${esc(b.slot)}</td><td style="font-size:0.8rem">${b.pax || 1}</td><td><span class="sbadge ${stageBadge(b.status)}">${esc(b.status)}</span>${statusExtra}</td>${showActions ? `<td style="white-space:nowrap">${actions}${noteToggle}</td>` : ''}</tr>`;
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
      saveBookings(getBookings().map(b => b.id === bkId ? { ...b, status: 'Cancelled' } : b));
      renderMyBookings(); renderDashboardBookings();
      toast('Booking cancelled.');
      if (bkId && !bkId.startsWith('BK-')) {
        try { await fetch(`/api/booking/${encodeURIComponent(bkId)}`, { method: 'DELETE' }); }
        catch (e) { console.warn('[cancel] cancel request failed (non-fatal):', e); }
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
    if ($('bookingCountBadge')) $('bookingCountBadge').textContent = _bookingsLoaded ? up.length + ' Active' : '…';
    const statusEl = $('nextBookingStatus');
    if (up.length) {
      if ($('nextBookingTitle')) $('nextBookingTitle').textContent = `${up[0].emoji} ${up[0].facilityName}`;
      if ($('nextBookingTime'))  $('nextBookingTime').textContent  = `${fmtDate(up[0].date)} · ${up[0].slot}`;
      // The soonest booking can be Deposit Pending - surface that here too, not
      // just in the full My Bookings list, since this hero card is the first
      // thing a resident sees and would otherwise look identical either way.
      if (statusEl) {
        if (up[0].status === 'Deposit Pending') {
          statusEl.hidden = false;
          statusEl.className = 'matters-status matters-status--warn';
          statusEl.textContent = `⚠ ${_depositCountdown(up[0].depositDueAt)} to confirm`;
        } else {
          statusEl.hidden = true;
        }
      }
    } else {
      // Distinguish "haven't fetched yet" from "genuinely no bookings" so the
      // resident doesn't see a false-negative flash while the first sync is
      // still in flight.
      if ($('nextBookingTitle')) $('nextBookingTitle').textContent = _bookingsLoaded ? 'No upcoming bookings' : 'Loading…';
      if ($('nextBookingTime'))  $('nextBookingTime').textContent  = '';
      if (statusEl) statusEl.hidden = true;
    }
    const db = $('dashBookings');
    if (db) db.innerHTML = up.length
      ? up.slice(0, 5).map(b => `<div class="booking-row"><div><div class="booking-facility">${b.emoji} ${esc(b.facilityName)}</div><div class="booking-time">${fmtDate(b.date)} · ${esc(b.slot)}</div></div><span class="sbadge ${stageBadge(b.status)}">${esc(b.status)}</span></div>`).join('')
      : `<div class="panel-empty">${_bookingsLoaded ? 'No bookings on record.' : 'Loading…'}</div>`;
    // The footer link doubles as "create" (empty state) and "view everything"
    // (once bookings exist) - static "Book a facility →" text was wrong once a
    // booking was already showing above it, and gave no hint that there were
    // more than the 5 rows actually rendered.
    const dbLink = $('dashBookingsLink');
    if (dbLink) {
      dbLink.textContent = !up.length ? 'Book a facility →'
        : up.length > 5 ? `View all ${up.length} bookings →`
        : 'View My Bookings →';
    }
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
    const OK_CSS   = 'display:block;margin-top:6px;font-size:0.8rem;padding:8px 12px;border-radius:6px;line-height:1.5;background:rgba(39,174,96,.1);color:#27ae60;border:1px solid rgba(39,174,96,.3)';
    const WARN_CSS = 'display:block;margin-top:6px;font-size:0.8rem;padding:8px 12px;border-radius:6px;line-height:1.5;background:rgba(192,57,43,.08);color:#c0392b;border:1px solid rgba(192,57,43,.25)';
    if (booking.status !== 'Confirmed') {
      statusEl.style.cssText = WARN_CSS;
      statusEl.textContent = `This booking is still ${booking.status.toLowerCase()}. Please wait for it to be confirmed before registering guests for this event.`;
      if (btn) btn.disabled = true;
      return;
    }
    // Confirmed: show how many of the booking's guest slots are used. pax is
    // TOTAL occupants incl. the resident host, so guests allowed = pax - 1
    // (mirrors the server-side cap). Closed/cancelled passes don't count.
    const cap  = Math.max(0, (booking.pax || 1) - 1);
    const used = _myGuests.filter(g => g.linkedBookingId === id && g.stage !== 'Closed').length;
    if (cap === 0) {
      statusEl.style.cssText = WARN_CSS;
      statusEl.textContent = 'This booking was made for you only, so it has no guest slots. Book with more pax to add guests.';
      if (btn) btn.disabled = true;
    } else if (used >= cap) {
      statusEl.style.cssText = WARN_CSS;
      statusEl.textContent = `All ${cap} guest slot${cap === 1 ? '' : 's'} for this booking are used.`;
      if (btn) btn.disabled = true;
    } else {
      statusEl.style.cssText = OK_CSS;
      statusEl.textContent = `✓ Booking confirmed - ${used} of ${cap} guest slot${cap === 1 ? '' : 's'} used.`;
      if (btn) btn.disabled = false;
    }
  }

  // Leave guest-edit mode: restore the form's Register button + hide the linked
  // booking row (which the edit flow disables, since a pass's booking is fixed).
  function exitGuestEditMode() {
    _editingGuestId = null;
    const btn = $('gRegisterBtn'); if (btn) btn.textContent = 'Register Visitor';
    const lb = $('gLinkedBooking'); if (lb) { const grp = lb.closest('.form-group'); if (grp) grp.style.display = ''; }
  }

  // Enter guest-edit mode: pull the pass's current values into the same inline
  // form used for creation, so a resident can correct a typo instead of having
  // to cancel and re-register (the reference/QR stays the same). Only offered
  // while the pass is still Registered - see the edit button in renderRecords.
  async function startEditGuest(id) {
    try {
      const res  = await fetch(`/api/guest/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not open this pass for editing.', 'err'); return; }
      const g = data.guest;
      $('gVisitorType').value  = g.visitorType || '';
      $('gVisitorName').value  = g.visitorName || '';
      $('gVisitorEmail').value = g.visitorEmail || '';
      $('gVisitorPhone').value = g.visitorPhone || '';
      if ($('gVisitorIc')) $('gVisitorIc').value = g.visitorIc || '';
      if ($('gVehicle'))   $('gVehicle').value   = g.visitorVehicle || '';
      $('gDate').value     = g.visitDate || '';
      $('gDuration').value = g.duration || 'Single Visit (Day)';
      _editingGuestId = id;
      // A pass's linked booking is fixed once created, so hide that control while
      // editing and clear any capacity gate it may have placed on the button.
      const lb = $('gLinkedBooking');
      if (lb) { lb.value = ''; const grp = lb.closest('.form-group'); if (grp) grp.style.display = 'none'; updateGuestBookingStatus(); }
      const btn = $('gRegisterBtn'); if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
      setMsg('gMsg', 'Editing a registered pass — update the details and save. The reference stays the same.');
      const form = $('gVisitorType'); if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { toast('Connection error. Please try again.', 'err'); }
  }

  // Leave defect-edit mode: restore the form's Submit button.
  function exitDefectEditMode() {
    _editingDefectId = null;
    const btn = $('dSubmitBtn'); if (btn) btn.textContent = 'Submit Report';
  }

  // Enter defect-edit mode: pull the report's current values into the submit
  // form so a resident can correct it. Only offered while still 'Reported'
  // (before management acts) - see the edit button in renderRecords.
  async function startEditDefect(id) {
    try {
      const res  = await fetch(`/api/defect/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not open this report for editing.', 'err'); return; }
      const d = data.defect;
      if ($('dDesc'))             $('dDesc').value = d.description || '';
      if ($('dLocation'))         $('dLocation').value = d.location || '';
      if ($('dCategory'))         $('dCategory').value = d.category || '';
      if ($('dSecondaryCategory')) $('dSecondaryCategory').value = d.secondaryCategory || '';
      const urgRadio = document.querySelector(`input[name="dUrgency"][value="${d.urgency}"]`);
      if (urgRadio) { urgRadio.checked = true; urgRadio.dispatchEvent(new Event('change', { bubbles: true })); }
      // A new photo can be attached to replace the old one, but we can't refill a
      // file input; leaving it empty keeps the existing photo server-side.
      if ($('dPhoto')) { $('dPhoto').value = ''; const n = $('dPhotoName'); if (n) { n.textContent = 'Keep current photo (or choose a new one)…'; n.classList.remove('has-file'); } }
      _editingDefectId = id;
      const btn = $('dSubmitBtn'); if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
      setMsg('dMsg', 'Editing your report — update the details and save.');
      const form = $('dDesc'); if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { toast('Connection error. Please try again.', 'err'); }
  }

  // Leave feedback-edit mode: restore the form's Submit button.
  function exitFeedbackEditMode() {
    _editingFeedbackId = null;
    const btn = $('fbSubmitBtn'); if (btn) btn.textContent = 'Submit';
    if (typeof highlightFbEditing === 'function') highlightFbEditing();
  }

  // Enter feedback-edit mode: pull the submission's values into the form. Only
  // offered while still 'Submitted' (before management reviews it).
  async function startEditFeedback(id) {
    try {
      const res  = await fetch(`/api/feedback/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not open this submission for editing.', 'err'); return; }
      const f = data.feedback;
      if ($('fbType')) { $('fbType').value = f.type || 'Complaint'; }
      updateFbCategories(); // rebuild category list + labels for the type
      // A stored category that isn't one of the presets was entered via "Others"
      // — restore it into the specify box.
      const sel = $('fbCategory');
      const known = sel && [...sel.options].some(o => o.value === f.category);
      if (sel) {
        if (f.category && !known) { sel.value = 'Others'; if ($('fbCategoryOther')) $('fbCategoryOther').value = f.category; }
        else { sel.value = f.category || ''; }
      }
      toggleFbOther();
      if ($('fbDesc'))     { $('fbDesc').value = f.description || ''; updateFbDescCount(); }
      if ($('fbDate'))     $('fbDate').value = f.incident_date || '';
      if ($('fbTime'))     $('fbTime').value = f.incident_time || '';
      // A new photo replaces the old one; leaving it empty keeps the existing one.
      if ($('fbPhoto')) { $('fbPhoto').value = ''; const n = $('fbPhotoName'); if (n) { n.textContent = f.photo ? 'Keep current photo (or choose a new one)…' : 'Choose a photo…'; n.classList.remove('has-file'); } }
      _editingFeedbackId = id;
      highlightFbEditing();
      const btn = $('fbSubmitBtn'); if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
      setMsg('fbMsg', 'Editing your submission — update the details and save.');
      const form = $('fbType'); if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { toast('Connection error. Please try again.', 'err'); }
  }

  // Mark the parcel card currently open in the edit form (survives poll re-renders).
  function highlightParcelEditing() {
    const wrap = $('parcelList'); if (!wrap) return;
    wrap.querySelectorAll('details.rec-item.rec-editing').forEach(d => d.classList.remove('rec-editing'));
    if (_editingParcelId) wrap.querySelector(`[data-pc-edit-id="${CSS.escape(_editingParcelId)}"]`)?.closest('details')?.classList.add('rec-editing');
  }

  // Leave parcel-edit mode: restore the form's Notify button.
  function exitParcelEditMode() {
    _editingParcelId = null;
    const btn = $('pcSubmitBtn'); if (btn) btn.textContent = 'Notify Guardhouse';
    if (typeof highlightParcelEditing === 'function') highlightParcelEditing();
  }

  // Enter parcel-edit mode: pull the notification's values into the form. Only
  // offered while still 'Notified' (before the parcel arrives).
  async function startEditParcel(id) {
    try {
      const res  = await fetch(`/api/parcel/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not open this parcel for editing.', 'err'); return; }
      const p = data.parcel;
      if ($('pcRef'))       $('pcRef').value = p.reference || '';
      if ($('pcCourier'))   $('pcCourier').value = p.courier || '';
      if ($('pcDesc'))      $('pcDesc').value = p.description || '';
      if ($('pcCollector')) $('pcCollector').value = p.authorizedCollector || '';
      _editingParcelId = id;
      highlightParcelEditing();
      const btn = $('pcSubmitBtn'); if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
      setMsg('pcMsg', 'Editing your parcel notification — update the details and save.');
      const form = $('pcRef'); if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { toast('Connection error. Please try again.', 'err'); }
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
        depositDueAt: it.depositDueAt || '',
        cancelReason: it.cancelReason || '',
        depositStatus: it.depositStatus || 'none',
        depositNote:   it.depositNote || '',
      }));
    } catch { return; }
    _bookingsLoaded = true;
    renderMyBookings(); renderDashboardBookings(); populateBookingSelector();
  }

  // My Guests & My Defects
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

  // Matches both the legacy 4-digit suffix and the current base32 token, so
  // passes issued before/after the format change both surface a QR button.
  const REF_RE = /GST-\d{8}-[0-9A-Z]{4,}/;

  // Guest pass QR - generated locally with qrcodejs (loaded in <head>, already
  // CSP-allowed) instead of round-tripping the visitor's reference through a
  // third-party image API just to render a QR code. Draws synchronously into
  // a container element (a canvas, when the browser supports it).
  function renderQrInto(container, ref, size) {
    container.innerHTML = '';
    new window.QRCode(container, { text: ref, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
    const el = container.querySelector('canvas, img');
    return { el, url: el.tagName === 'CANVAS' ? el.toDataURL() : el.src };
  }
  function showGuestQr(ref) {
    if (!window.Swal) return;
    window.Swal.fire({
      title:              'Guest Pass',
      html:               `<div style="text-align:center">
        <div style="font-size:0.8rem;color:#312e81;font-family:'Courier New',monospace;font-weight:600;letter-spacing:0.04em;margin-bottom:12px">${esc(ref)}</div>
        <div id="gQrBox" style="width:230px;height:230px;margin:0 auto;border-radius:10px;overflow:hidden;border:1px solid #e8e0d0;display:flex;align-items:center;justify-content:center"></div>
        <div style="margin-top:14px"><a id="gQrDl" href="#"
           style="display:inline-block;background:#312e81;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:0.82rem;font-weight:600">&#10515; Download QR</a></div>
        <div style="margin-top:10px;font-size:0.72rem;color:#9a9088">Show this at the guardhouse on arrival.</div>
      </div>`,
      didOpen: () => {
        const box = document.getElementById('gQrBox');
        const dl  = document.getElementById('gQrDl');
        try {
          const { url } = renderQrInto(box, ref, 230);
          dl.href = url; dl.setAttribute('download', `guest-pass-${ref}.png`);
        } catch {
          box.innerHTML = '<div style="padding:16px;color:var(--muted,#9a9088);font-size:0.82rem">QR unavailable. Use your reference code at the guardhouse.</div>';
          dl.style.display = 'none';
        }
      },
      confirmButtonText:  'Done',
      confirmButtonColor: '#312e81',
    });
  }
  // Fills every inline QR placeholder under `root` after it's been inserted
  // into the DOM (renderRecords builds the row markup in one string) - see
  // the qrHtml block below.
  function fillQrImages(root) {
    root.querySelectorAll('.qr-img[data-qr-ref]').forEach(box => {
      const ref = box.dataset.qrRef;
      const dl  = root.querySelector(`a.qr-dl-btn[data-qr-dl="${CSS.escape(ref)}"]`);
      try {
        const { url } = renderQrInto(box, ref, 110);
        if (dl) { dl.href = url; dl.setAttribute('download', `guest-pass-${ref}.png`); dl.classList.remove('qr-dl-pending'); }
      } catch {
        box.outerHTML = '<div class="qr-err">QR unavailable - show reference code at guardhouse.</div>';
      }
    });
  }

  function renderRecords(el, cnt, items, emptyMsg, opts) {
    opts = opts || {};
    if (cnt) cnt.textContent = (items ? items.length : 0) + ' Total';
    if (!items || !items.length) { el.innerHTML = `<div class="panel-empty">${emptyMsg}</div>`; return; }
    // The live-poll re-renders this list wholesale every few seconds while the
    // tab is open, which would otherwise snap a manually-opened <details> shut
    // out from under the user mid-read. Remember which rows were open (by
    // their name, which carries a unique ref/id) and restore it after rebuild.
    const openKeys = new Set([...el.querySelectorAll('details.rec-item[open]')].map(d => d.dataset.key));
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
      // Only while still Registered - once a visitor has actually checked in
      // there's nothing left to edit or cancel.
      const editable = refCode && item.stage === 'Registered' && item.id;
      const editBtn = editable
        ? `<button class="rec-edit-btn" type="button" data-edit-id="${esc(item.id)}" title="Edit this guest pass" aria-label="Edit this guest pass"><span class="material-symbols-outlined">edit</span></button>`
        : '';
      const cancelBtn = editable
        ? `<button class="rec-cancel-btn" type="button" data-cancel-id="${esc(item.id)}" title="Cancel this guest pass" aria-label="Cancel this guest pass"><span class="material-symbols-outlined">close</span></button>`
        : '';
      // Defect reports can be edited/withdrawn by the resident only while still
      // 'Reported' (before management acknowledges them).
      const defectEditable = opts.kind === 'defect' && item.stage === 'Reported' && item.id;
      const defectEditBtn = defectEditable
        ? `<button class="rec-edit-btn" type="button" data-defect-edit-id="${esc(item.id)}" title="Edit this report" aria-label="Edit this report"><span class="material-symbols-outlined">edit</span></button>`
        : '';
      const defectCancelBtn = defectEditable
        ? `<button class="rec-cancel-btn" type="button" data-defect-cancel-id="${esc(item.id)}" title="Withdraw this report" aria-label="Withdraw this report"><span class="material-symbols-outlined">close</span></button>`
        : '';
      // Feedback can be edited/withdrawn by the resident only while still
      // 'Submitted' (before management reviews it).
      const fbEditable = opts.kind === 'feedback' && item.stage === 'Submitted' && item.id;
      const fbEditBtn = fbEditable
        ? `<button class="rec-edit-btn" type="button" data-fb-edit-id="${esc(item.id)}" title="Edit this submission" aria-label="Edit this submission"><span class="material-symbols-outlined">edit</span></button>`
        : '';
      const fbCancelBtn = fbEditable
        ? `<button class="rec-cancel-btn" type="button" data-fb-cancel-id="${esc(item.id)}" title="Withdraw this submission" aria-label="Withdraw this submission"><span class="material-symbols-outlined">close</span></button>`
        : '';
      // Parcel notifications can be edited/cancelled by the resident only while
      // still 'Notified' (before the parcel physically arrives).
      const pcEditable = opts.kind === 'parcel' && item.stage === 'Notified' && item.id;
      const pcEditBtn = pcEditable
        ? `<button class="rec-edit-btn" type="button" data-pc-edit-id="${esc(item.id)}" title="Edit this parcel" aria-label="Edit this parcel"><span class="material-symbols-outlined">edit</span></button>`
        : '';
      const pcCancelBtn = pcEditable
        ? `<button class="rec-cancel-btn" type="button" data-pc-cancel-id="${esc(item.id)}" title="Cancel this parcel" aria-label="Cancel this parcel"><span class="material-symbols-outlined">close</span></button>`
        : '';
      const qrHtml = refCode ? `<div class="rec-qr">
          <div class="qr-img" data-qr-ref="${esc(refCode)}"></div>
          <a class="qr-dl-btn qr-dl-pending" data-qr-dl="${esc(refCode)}" href="#">
            <span class="material-symbols-outlined" style="font-size:1rem;vertical-align:-2px">download</span> Download QR
          </a>
        </div>` : '';

      // If ref wasn't already emitted by a custom field, show it explicitly
      const refInFields = (item.customFields || []).some(f => REF_RE.test(f.fieldValueString || ''));
      const refRow = refCode && !refInFields
        ? `<div class="rec-field"><span class="rec-label">Ref</span><span class="rec-ref">${esc(refCode)}</span></div>`
        : '';

      return `<details class="rec-item" data-key="${esc(item.name)}"${openKeys.has(item.name) ? ' open' : ''}>
        <summary class="rec-summary">
          <div class="rec-main">
            <span class="rec-name">${esc(item.displayName || issue || item.name)}</span>
            <span class="rec-meta">${subDate}</span>
          </div>
          ${qrBtn}
          ${editBtn}
          ${cancelBtn}
          ${defectEditBtn}
          ${defectCancelBtn}
          ${fbEditBtn}
          ${fbCancelBtn}
          ${pcEditBtn}
          ${pcCancelBtn}
          <span class="sbadge ${badge}">${esc(item.stage)}</span>
          <span class="rec-chevron">›</span>
        </summary>
        <div class="rec-body">
          ${opts.kind === 'defect' ? (() => {
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            let   cat   = (sv && sv.category) || issue.split('|')[0].split(':')[0].trim() || '';
            if (sv && sv.secondaryCategory) cat += ` + ${sv.secondaryCategory}`;
            const urg   = (sv && sv.urgency) || (item.name.match(/\[(emergency|urgent|routine)\]/i) || [])[1] || '';
            const photo = (sv && sv.photo) || '';
            return `
              <div class="rec-field"><span class="rec-label">Submitted date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Category</span>${esc(cat)}</div>
              <div class="rec-field"><span class="rec-label">Location</span>${esc((sv && sv.location) || '')}</div>
              <div class="rec-field"><span class="rec-label">Urgency Level</span>${esc(urg)}</div>
              <div class="rec-field"><span class="rec-label">Issue</span>${esc((sv && sv.desc) || '')}</div>
              ${photo ? `<div class="rec-field"><span class="rec-label">Photo</span><a href="${esc(photo)}" target="_blank" rel="noopener"><img src="${esc(photo)}" alt="defect photo" class="rec-photo-thumb" /></a></div>` : ''}`;
          })() : opts.kind === 'parcel' ? (() => {
            // Fall back to the parcel's GHL custom fields when no local copy exists.
            const cf = (re) => { const f = (item.customFields || []).find(c => re.test(c.label || '')); return f ? (f.fieldValueString || '') : ''; };
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const ref   = (sv && sv.ref) || cf(/reference|tracking/i) || (REF_RE.exec(item.name) || [])[0] || cleanIssue(item.name) || '';
            const courier   = (sv && sv.courier) || cf(/courier|sender/i);
            const descTxt   = (sv && sv.desc) || cf(/description|item|content/i);
            const collector = (sv && sv.collector && sv.collector.trim()) || cf(/collector|authoriz/i);
            // Once received, show arrival + the 7-day collection deadline (the
            // point at which it's auto-returned) so the resident knows the clock.
            const fmtD = iso => { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }); } catch { return ''; } };
            let collectRows = '';
            if (sv && sv.receivedAt && item.stage === 'Received') {
              const arrived  = fmtD(sv.receivedAt);
              const deadline = fmtD(new Date(new Date(sv.receivedAt).getTime() + 7 * 86400000));
              collectRows = `
              <div class="rec-field"><span class="rec-label">Arrived</span>${esc(arrived)}</div>
              <div class="rec-field"><span class="rec-label">Collect By</span><strong>${esc(deadline)}</strong></div>`;
            }
            return `
              <div class="rec-field"><span class="rec-label">Date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Parcel Reference</span>${esc(ref)}</div>
              <div class="rec-field"><span class="rec-label">Courier / Sender</span>${esc(courier || '')}</div>
              <div class="rec-field"><span class="rec-label">Description</span>${esc(descTxt || '')}</div>
              ${collector ? `<div class="rec-field"><span class="rec-label">Authorized Collector</span>${esc(collector)}</div>` : ''}
              ${collectRows}`;
          })() : opts.kind === 'move' ? (() => {
            const unitM = String(item.name || '').match(/#\s*([\w-]+)/);
            const unit  = (member && member.unit) || (unitM ? unitM[1] : '') || '';
            const mType = (sv && sv.move_type) || (item.name.split(' - ')[0].trim()) || '';
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
            const ref = (sv && sv.reference) || '';
            // Incident date/time only apply to a Complaint — omit the rows otherwise.
            const incidentRows = type === 'Complaint'
              ? `<div class="rec-field"><span class="rec-label">Date of Incident</span>${esc(incDate)}</div>
              <div class="rec-field"><span class="rec-label">Time of Incident</span>${esc((sv && sv.incident_time) || '')}</div>`
              : '';
            const response = (sv && sv.response) || '';
            const respondedAt = (sv && sv.respondedAt) ? new Date(sv.respondedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }) : '';
            const fbPhoto = (sv && sv.photo) || '';
            return `
              ${ref ? `<div class="rec-field"><span class="rec-label">Reference</span><span class="rec-ref">${esc(ref)}</span></div>` : ''}
              <div class="rec-field"><span class="rec-label">Submitted Date</span>${subDate}</div>
              <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(unit)}</div>
              <div class="rec-field"><span class="rec-label">Type</span>${esc(type)}</div>
              <div class="rec-field"><span class="rec-label">Category</span>${esc((sv && sv.category) || '')}</div>
              ${incidentRows}
              <div class="rec-field"><span class="rec-label">${esc(descLabel)}</span>${esc((sv && sv.desc) || '')}</div>
              ${fbPhoto ? `<div class="rec-field"><span class="rec-label">Photo</span><a href="${esc(fbPhoto)}" target="_blank" rel="noopener"><img src="${esc(fbPhoto)}" alt="attached photo" class="rec-photo-thumb" /></a></div>` : ''}
              ${response ? `<div class="rec-response"><div class="rec-response-head">Management Response${respondedAt ? ` · ${respondedAt}` : ''}</div><div class="rec-response-body">${esc(response)}</div></div>` : ''}`;
          })() : `
          ${refRow}${fields}${qrHtml}
          <div class="rec-field"><span class="rec-label">Submitted</span>${date}</div>`}
        </div>
      </details>`;
    }).join('');

    // Clicking the QR button (or the inline preview) opens the pass without
    // toggling the <details>.
    el.querySelectorAll('.rec-qr-btn[data-qr-ref], .qr-img[data-qr-ref]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      showGuestQr(btn.dataset.qrRef);
    }));
    el.querySelectorAll('[data-edit-id]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      startEditGuest(btn.dataset.editId);
    }));
    el.querySelectorAll('[data-cancel-id]').forEach(btn => btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.cancelId;
      const proceed = window.Swal
        ? (await window.Swal.fire({
            title: 'Cancel this guest pass?',
            text:  'The visitor will no longer be able to enter using this pass.',
            showCancelButton: true, confirmButtonText: 'Cancel Pass', cancelButtonText: 'Keep It',
            confirmButtonColor: '#c0392b', reverseButtons: true,
          })).isConfirmed
        : confirm('Cancel this guest pass?');
      if (!proceed) return;
      btn.disabled = true;
      try {
        const res  = await fetch(`/api/guest/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { toast(data.message || 'Could not cancel.', 'err'); btn.disabled = false; return; }
        toast('Guest pass cancelled.');
        loadMyGuests();
      } catch {
        toast('Connection error. Please try again.', 'err');
        btn.disabled = false;
      }
    }));
    el.querySelectorAll('[data-defect-edit-id]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      startEditDefect(btn.dataset.defectEditId);
    }));
    el.querySelectorAll('[data-defect-cancel-id]').forEach(btn => btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.defectCancelId;
      const proceed = window.Swal
        ? (await window.Swal.fire({
            title: 'Withdraw this report?',
            text:  'This defect report will be removed and no longer sent to management.',
            showCancelButton: true, confirmButtonText: 'Withdraw', cancelButtonText: 'Keep It',
            confirmButtonColor: '#c0392b', reverseButtons: true,
          })).isConfirmed
        : confirm('Withdraw this report?');
      if (!proceed) return;
      btn.disabled = true;
      try {
        const res  = await fetch(`/api/defect/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { toast(data.message || 'Could not withdraw.', 'err'); btn.disabled = false; return; }
        if (_editingDefectId === id) { exitDefectEditMode(); clr(['dDesc']); setMsg('dMsg', ''); }
        toast('Report withdrawn.');
        loadMyDefects();
      } catch {
        toast('Connection error. Please try again.', 'err');
        btn.disabled = false;
      }
    }));
    el.querySelectorAll('[data-fb-edit-id]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      startEditFeedback(btn.dataset.fbEditId);
    }));
    el.querySelectorAll('[data-fb-cancel-id]').forEach(btn => btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.fbCancelId;
      const proceed = window.Swal
        ? (await window.Swal.fire({
            title: 'Withdraw this submission?',
            text:  'It will be removed and no longer sent to management.',
            showCancelButton: true, confirmButtonText: 'Withdraw', cancelButtonText: 'Keep It',
            confirmButtonColor: '#c0392b', reverseButtons: true,
          })).isConfirmed
        : confirm('Withdraw this submission?');
      if (!proceed) return;
      btn.disabled = true;
      try {
        const res  = await fetch(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { toast(data.message || 'Could not withdraw.', 'err'); btn.disabled = false; return; }
        if (_editingFeedbackId === id) { exitFeedbackEditMode(); clr(['fbDesc', 'fbDate', 'fbTime']); setMsg('fbMsg', ''); }
        toast('Submission withdrawn.');
        loadMyFeedback();
      } catch {
        toast('Connection error. Please try again.', 'err');
        btn.disabled = false;
      }
    }));
    el.querySelectorAll('[data-pc-edit-id]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      startEditParcel(btn.dataset.pcEditId);
    }));
    el.querySelectorAll('[data-pc-cancel-id]').forEach(btn => btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.pcCancelId;
      const proceed = window.Swal
        ? (await window.Swal.fire({
            title: 'Cancel this parcel notification?',
            text:  'The guardhouse will no longer expect this parcel.',
            showCancelButton: true, confirmButtonText: 'Cancel It', cancelButtonText: 'Keep It',
            confirmButtonColor: '#c0392b', reverseButtons: true,
          })).isConfirmed
        : confirm('Cancel this parcel notification?');
      if (!proceed) return;
      btn.disabled = true;
      try {
        const res  = await fetch(`/api/parcel/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { toast(data.message || 'Could not cancel.', 'err'); btn.disabled = false; return; }
        if (_editingParcelId === id) { exitParcelEditMode(); clr(['pcRef', 'pcCourier', 'pcDesc', 'pcCollector']); setMsg('pcMsg', ''); }
        toast('Parcel notification cancelled.');
        loadMyParcels();
      } catch {
        toast('Connection error. Please try again.', 'err');
        btn.disabled = false;
      }
    }));
    fillQrImages(el);
  }

  async function loadMyGuests(silent) {
    const el  = $('myGuestsList');
    const cnt = $('myGuestsCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const res  = await fetch('/api/guest/mine');
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load guests.')}</div>`; return; }
      // Extract visitor name from "GST-YYYYMMDD-#### - Visitor Name (#unit)"
      const GUEST_VISITOR_RE = / - \s*(.+?)\s*(?:\(#?[^)]+\))?\s*$/;
      (data.items || []).forEach(item => {
        const m = GUEST_VISITOR_RE.exec(item.name || '');
        if (m) item.displayName = m[1].trim();
      });
      _myGuests = data.items || []; // cached so the linked-booking slot hint can count locally
      updateGuestBookingStatus();
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
      // Defects are a real Mongo-backed endpoint — /api/defect/mine returns the
      // full report (stage included), so build the record rows from it directly
      // rather than the generic /api/opportunities + local-history pairing the
      // still-mocked pipelines use.
      const res  = await fetch('/api/defect/mine');
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load reports.')}</div>`; return; }
      const items = (data.items || []).map(x => ({
        id: x.id, stage: x.stage, createdAt: x.createdAt, customFields: [],
        name: (x.category ? x.category + ': ' : '') + (x.desc || ''),
      }));
      renderRecords(el, cnt, items, 'No defect reports on record.', { kind: 'defect', saved: data.items });
    } catch (e) { console.error('[defects]', e); el.innerHTML = '<div class="panel-empty">Connection error loading reports.</div>'; }
  }

  // Feedback category filter
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
    // Incident date/time only make sense for a Complaint — hide the row (and
    // clear it) for Feedback/Suggestion so an "incident date" isn't asked for.
    const dateRow = $('fbDate')?.closest('.form-row');
    if (dateRow) {
      const showIncident = type === 'Complaint';
      dateRow.style.display = showIncident ? '' : 'none';
      if (!showIncident) { if ($('fbDate')) $('fbDate').value = ''; if ($('fbTime')) $('fbTime').value = ''; }
    }
    toggleFbOther();
  }
  // Reveal a free-text "please specify" box when the category is "Others", so
  // the actual category isn't lost.
  function toggleFbOther() {
    const grp = $('fbCategoryOtherGroup');
    if (!grp) return;
    const isOther = $('fbCategory') && $('fbCategory').value === 'Others';
    grp.style.display = isOther ? '' : 'none';
    if (!isOther && $('fbCategoryOther')) $('fbCategoryOther').value = '';
  }
  // Effective category = the specify text when "Others" is chosen, else the select.
  function fbEffectiveCategory() {
    const sel = $('fbCategory') ? $('fbCategory').value : '';
    if (sel === 'Others') { const t = $('fbCategoryOther') ? $('fbCategoryOther').value.trim() : ''; return t || 'Others'; }
    return sel;
  }
  const fbTypeEl = $('fbType');
  if (fbTypeEl) fbTypeEl.addEventListener('change', updateFbCategories);
  if ($('fbCategory')) $('fbCategory').addEventListener('change', toggleFbOther);
  // Live character counter for the description.
  function updateFbDescCount() {
    const el = $('fbDesc'), c = $('fbDescCount');
    if (el && c) c.textContent = `${el.value.length} / ${el.maxLength}`;
  }
  if ($('fbDesc')) $('fbDesc').addEventListener('input', updateFbDescCount);
  updateFbDescCount();
  // An incident can only have happened in the past — cap the picker at today
  // (SGT), with a sane 2-year floor so absurd dates can't be entered.
  if ($('fbDate')) {
    $('fbDate').max = todaySGT();
    $('fbDate').min = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().slice(0, 10); })();
  }
  // Photo file-name label + optional-photo picker.
  if ($('fbPhoto')) {
    $('fbPhoto').addEventListener('change', () => {
      const nameEl = $('fbPhotoName');
      const file   = $('fbPhoto').files[0];
      if (nameEl) { nameEl.textContent = file ? file.name : 'Choose a photo…'; nameEl.classList.toggle('has-file', !!file); }
    });
  }
  updateFbCategories(); // sync categories/labels/incident-row to the default type on load

  let _fbItems = []; // latest /api/feedback/mine rows, for client-side type filtering
  function renderFbFiltered() {
    const el = $('myFeedback'), cnt = $('myFeedbackCount');
    if (!el) return;
    const filter = $('fbMineFilter') ? $('fbMineFilter').value : '';
    const rows = (filter ? _fbItems.filter(x => x.type === filter) : _fbItems);
    const items = rows.map(x => ({
      id: x.id, stage: x.stage, createdAt: x.createdAt, customFields: [],
      name: (x.type ? x.type + ' - ' : '') + (x.desc || ''),
    }));
    const emptyMsg = filter ? `No ${filter.toLowerCase()} submissions.` : 'No submissions on record.';
    renderRecords(el, cnt, items, emptyMsg, { kind: 'feedback', saved: rows });
    highlightFbEditing();
  }
  // Mark the card currently open in the edit form (survives poll re-renders).
  function highlightFbEditing() {
    const wrap = $('myFeedback'); if (!wrap) return;
    wrap.querySelectorAll('details.rec-item.rec-editing').forEach(d => d.classList.remove('rec-editing'));
    if (_editingFeedbackId) wrap.querySelector(`[data-fb-edit-id="${CSS.escape(_editingFeedbackId)}"]`)?.closest('details')?.classList.add('rec-editing');
  }

  async function loadMyFeedback(silent) {
    const el  = $('myFeedback');
    const cnt = $('myFeedbackCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      // Feedback is a real Mongo-backed endpoint — /api/feedback/mine returns the
      // full submission (stage included), so build rows from it directly.
      const res  = await fetch('/api/feedback/mine');
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load submissions.')}</div>`; return; }
      _fbItems = data.items || [];
      renderFbFiltered();
    } catch (e) { console.error('[feedback]', e); el.innerHTML = '<div class="panel-empty">Connection error loading submissions.</div>'; }
  }
  if ($('fbMineFilter')) $('fbMineFilter').addEventListener('change', renderFbFiltered);

  // Real backend now (see backend/controllers/move.controller.js) - /api/move/mine
  // already returns complete, correct fields directly, so unlike the other
  // still-mock pipelines this doesn't need renderRecords' GHL-name-parsing +
  // local-saved-pool reconciliation trick at all.
  async function loadMyMoves(silent) {
    const el  = $('myMovesList');
    const cnt = $('myMovesCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      const res  = await fetch('/api/move/mine');
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load move bookings.')}</div>`; return; }
      const items = data.items || [];
      if (cnt) cnt.textContent = items.length + ' Total';
      if (!items.length) { el.innerHTML = '<div class="panel-empty">No move bookings on record.</div>'; return; }
      el.innerHTML = items.map(m => {
        const badge = stageBadge(m.status);
        const submitted = m.createdAt
          ? new Date(m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' })
          : ' - ';
        const cancelHint = m.cancelReason === 'deposit_expired'
          ? '<div class="rec-field"><span class="rec-label">Note</span>The 24-hour deposit payment window passed without payment.</div>' : '';
        return `<details class="rec-item">
          <summary class="rec-summary">
            <div class="rec-main">
              <span class="rec-name">${esc(m.moveType)}</span>
              <span class="rec-meta">${submitted}</span>
            </div>
            <span class="sbadge ${badge}">${esc(m.status)}</span>
            <span class="rec-chevron">›</span>
          </summary>
          <div class="rec-body">
            <div class="rec-field"><span class="rec-label">Submitted Date</span>${submitted}</div>
            <div class="rec-field"><span class="rec-label">Unit Number</span>${esc(member.unit || '')}</div>
            <div class="rec-field"><span class="rec-label">Move In/Out Date</span>${esc(fmtDate(m.moveDate))}</div>
            <div class="rec-field"><span class="rec-label">Move In/Out Time</span>${esc(m.moveTime)}</div>
            ${m.notes ? `<div class="rec-field"><span class="rec-label">Notes</span>${esc(m.notes)}</div>` : ''}
            ${cancelHint}
          </div>
        </details>`;
      }).join('');
    } catch (e) { console.error('[moves]', e); el.innerHTML = '<div class="panel-empty">Connection error loading move bookings.</div>'; }
  }

  async function loadMyParcels(silent) {
    const el  = $('parcelList');
    const cnt = $('parcelCount');
    if (!el || !member) return;
    if (!member.contact_id && !member.email) { el.innerHTML = '<div class="panel-empty">No account ID - please log out and back in.</div>'; return; }
    if (!silent) el.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
      // Parcels are a real Mongo-backed endpoint — /api/parcel/mine returns the
      // full record (stage included), so build rows from it directly.
      const res  = await fetch('/api/parcel/mine');
      const data = await res.json();
      if (!data.success) { el.innerHTML = `<div class="panel-empty">${esc(data.message || 'Could not load parcels.')}</div>`; return; }
      const items = (data.items || []).map(x => ({
        id: x.id, stage: x.stage, createdAt: x.createdAt, customFields: [], name: x.ref || '',
      }));
      renderRecords(el, cnt, items, 'No parcels on record.', { kind: 'parcel', saved: data.items });
      highlightParcelEditing();
    } catch (e) { console.error('[parcels]', e); el.innerHTML = '<div class="panel-empty">Connection error loading parcels.</div>'; }
  }

  async function loadParcelNotice() {
    const banner = $('parcelNoticeBanner');
    const text   = $('parcelNoticeText');
    if (!banner || !text || !member) return;
    try {
      const res  = await fetch('/api/parcel/mine');
      const data = await res.json();
      if (!data.success) return;
      // "Awaiting collection at the guardhouse" = physically Received (arrived).
      const awaiting = (data.items || []).filter(i => i.stage === 'Received');
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

  // Notices & AGM (announcements published by management)
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
    _noticesLoaded = true;

    function catSlug(cat) {
      const c = (cat || '').toLowerCase();
      if (c.includes('maint'))                  return 'maintenance';
      if (c.includes('agm') || c.includes('egm')) return 'agm';
      if (c.includes('rule'))                   return 'rule-change';
      if (c.includes('event'))                  return 'event';
      if (c.includes('safety'))                 return 'safety';
      return 'general';
    }

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
        : `<div class="panel-empty">${_noticesLoaded ? 'No notices.' : 'Loading…'}</div>`;
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

    // Dashboard cards: Upcoming Event (Event category) + Maintenance Alert (Maintenance category)
    const now = new Date();
    // Soonest announcement of a category whose window hasn't ended yet (upcoming or in progress).
    // Returns the soonest active match plus how many OTHER active matches
    // exist, so the single-slot hero card can still hint "+N more" instead of
    // silently hiding every match past the first (see the "+N more" additions
    // below).
    function nextOf(slug) {
      const matches = items
        .filter(a => a.eventAt && catSlug(a.category) === slug)
        .filter(a => new Date(a.eventEndAt || a.eventAt) >= now)
        .sort((x, y) => new Date(x.eventAt) - new Date(y.eventAt));
      return matches.length ? { item: matches[0], extra: matches.length - 1 } : null;
    }
    const loadingOr = fallback => _noticesLoaded ? fallback : 'Loading…';

    const ev = nextOf('event');
    if ($('upcomingEventTitle')) $('upcomingEventTitle').textContent = ev ? ev.item.title : loadingOr('No upcoming events');
    if ($('upcomingEventSub'))   $('upcomingEventSub').textContent   = ev ? annWhen(ev.item) + (ev.extra > 0 ? ` · +${ev.extra} more` : '') : '';

    const mt = nextOf('maintenance');
    if ($('alertTitle')) $('alertTitle').textContent = mt ? mt.item.title : loadingOr('No active alerts');
    if ($('alertSub')) {
      const inProgress = mt && new Date(mt.item.eventAt) <= now;
      $('alertSub').textContent = mt ? (inProgress ? 'In progress · ' : '') + annWhen(mt.item) + (mt.extra > 0 ? ` · +${mt.extra} more` : '') : '';
    }
  }

  // Payments (read-only history)
  // Move is one payment: USD 200 admin fee + USD 2000 refundable deposit = USD 2200.
  // On completion the USD 2000 deposit is refunded (shown on the Deposit Refunded card).
  const MOVE_REFUNDABLE_DEPOSIT = 2000;
  // bbq/pool/verandah are bootstrap fallback values only, overwritten below from
  // the server the instant the fetch resolves - the real source of truth is
  // depositAmount/refundableAmount in backend/config/facilities.js. move/default
  // aren't facility bookings (they're the separate, still-mock Move-In pipeline)
  // so they stay local literals; there's no backend config for them to drift from.
  const PAY_DEPOSITS = { bbq: 200, pool: 200, verandah: 600, move: 2200, default: 50 };
  // Only set for facilities where part of depositAmount is a non-refundable fee
  // (Verandah: $600 total, $400 of it refundable) - used purely to show an
  // informational breakdown on the pending card, not to gate payment at all.
  const REFUNDABLE_AMOUNTS = { verandah: 400, move: 2000 };
  // Which facility keys actually require a deposit - driven entirely by the
  // server's own facility catalogue (backend/config/facilities.js), not
  // hand-copied here. Add `deposit: true` to a new facility server-side and it
  // shows up in the Payments tab automatically, no frontend change needed.
  // Bootstrap fallback matches today's catalogue; overwritten the instant the
  // fetch below resolves. 'move' isn't in this catalogue at all (it's a
  // separate always-deposit pipeline, not a facility), so it's added by hand.
  const DEPOSIT_FACILITY_KEYS = new Set(['bbq', 'pool', 'verandah']);
  (async () => {
    try {
      const res  = await fetch('/api/booking/facilities');
      const data = await res.json();
      const facs = data.facilities || [];
      DEPOSIT_FACILITY_KEYS.clear();
      facs.forEach(f => { if (f.deposit) DEPOSIT_FACILITY_KEYS.add(f.key); });
      facs.forEach(f => {
        if (!f.deposit || !f.depositAmount) return;
        PAY_DEPOSITS[f.key] = f.depositAmount;
        if (f.refundableAmount) REFUNDABLE_AMOUNTS[f.key] = f.refundableAmount;
      });
    } catch { /* keep the bootstrap fallback values above */ }
  })();
  // A deposit is outstanding only while at "Deposit Pending".
  const DEPOSIT_STAGES = new Set(['Deposit Pending']);
  function _facilityTitle(key, itemName) {
    if (key === 'move') {
      const n = (itemName || '').toLowerCase();
      return n.includes('move-out') || n.includes('move out') ? 'Move Out' : 'Move In';
    }
    const f = FACILITIES.find(x => x.key === key);
    if (f) return f.name;
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


  function _renderPayCard(item, type, isPending) {
    let key, amount;
    if (type === 'facility') {
      key    = item.facilityKey || 'default';
      amount = PAY_DEPOSITS[key] || PAY_DEPOSITS.default;
    } else {
      key    = 'move';
      amount = PAY_DEPOSITS.move;
    }
    const isVerandah = key === 'verandah';
    const amtStr     = `USD ${Number(amount).toFixed(2)}`;
    const title      = _facilityTitle(key, item.name);
    // Prefer clean local booking data; fall back to parsing the opportunity name.
    const details    = _localBookingDetail(key, item) || _parseBookingDetails(item);
    const rawLabel   = esc(item.name || (type === 'facility' ? 'Facility Booking' : 'Move In / Out'));
    // Two-line header used by all card variants. Pending deposits also get the
    // payment-window countdown so it's visible right where the Pay button
    // lives, not just buried in My Bookings/My Move Bookings.
    const countdownHtml = (isPending && item.depositDueAt)
      ? `<div class="pay-deposit-countdown">⚠ ${esc(_depositCountdown(item.depositDueAt))}</div>` : '';
    const headerHtml = `<div class="pay-facility-title">${esc(title)}</div>${details ? `<div class="pay-facility-detail">${esc(details)}</div>` : ''}${countdownHtml}`;

    // Pending deposits. Facilities that split the charge into a non-refundable
    // fee + a refundable deposit (currently just the Verandah) get a plain
    // informational breakdown line - it's not interactive/per-fee-payable,
    // since Stripe charges the whole amount in one go; Stripe's own checkout
    // page shows the same split as two line items at the point of payment.
    if (isPending) {
      const refundablePart = REFUNDABLE_AMOUNTS[key];
      const breakdownHtml = (refundablePart && refundablePart < amount)
        ? `<div class="pay-fee-breakdown">USD ${(amount - refundablePart).toFixed(2)} booking fee (non-refundable) + USD ${refundablePart.toFixed(2)} refundable deposit</div>`
        : '';
      return `<div class="pay-due">
        <div class="pay-due__body">${headerHtml}${breakdownHtml}</div>
        <div class="pay-due__right">
          <div class="pay-due__amt">${esc(amtStr)}</div>
          <button class="pay-pay-btn" data-pay-key="${esc(key)}" data-opp-id="${esc(item.id)}" data-amount="${Number(amount).toFixed(2)}" data-desc="${rawLabel}"${!(DEPOSIT_FACILITY_KEYS.has(key) || key === 'move') ? ' disabled title="No payment method configured"' : ''}>Pay Deposit</button>
        </div>
      </div>`;
    }

    // History: Confirmed (paid), Deposit Refunded (move-in/out), or a facility
    // deposit management has since resolved (see depositStatus - refunded back
    // to the resident, or forfeited with a reason, e.g. facility damage).
    const isRefunded  = item.stage === 'Deposit Refunded' || item.depositStatus === 'refunded';
    const isForfeited = item.depositStatus === 'forfeited';
    const baseMeta   = isVerandah ? 'Booking Fee + Refundable Deposit'
                     : key === 'move' ? 'Admin Fee + Refundable Deposit'
                     : 'Deposit';
    // Only the refundable deposit is returned on a move refund (admin fee is non-refundable).
    // A held deposit can outlive its booking (e.g. cancelled after the deposit
    // was already paid) - say so explicitly instead of claiming "Confirmed"
    // for a booking/move that no longer is.
    const histMeta   = isForfeited
                     ? `${baseMeta} · Forfeited${item.depositNote ? ` — ${esc(item.depositNote)}` : ''}`
                     : isRefunded
                     ? (key === 'move' ? 'Refundable Deposit · Refunded' : `${baseMeta} · Refunded`)
                     : item.stage === 'Cancelled'
                     ? `${baseMeta} · Held (booking cancelled - pending resolution)`
                     : `${baseMeta} · Confirmed`;
    const histAmtStr = (isRefunded && key === 'move')
                     ? `USD ${Number(MOVE_REFUNDABLE_DEPOSIT).toFixed(2)}`
                     : amtStr;
    const tagHtml    = isForfeited ? '<span class="pay-tag forfeited">forfeited</span>'
                     : isRefunded  ? '<span class="pay-tag refunded">refunded</span>'
                     : '<span class="pay-tag paid">paid</span>';
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
  // Payment History shows paid (Confirmed/Completed) AND Deposit Refunded records -
  // the latter mainly move-in/out deposits returned after the move completes.
  function _renderPayBlock(pending, confirmed, refunded) {
    const historyCount = confirmed.length + refunded.length;
    if (!pending.length && !historyCount)
      return '<div class="panel-empty" style="padding:16px">No records yet.</div>';
    let html = '';
    if (pending.length) {
      html += '<div class="pay-sub-head">Pending Deposit</div>';
      html += pending.map(([item, type]) => _renderPayCard(item, type, true)).join('');
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
          ${confirmed.map(([item, type]) => _renderPayCard(item, type, false)).join('')}`;
      }
      if (refunded.length) {
        html += `<div class="pay-sub-head" style="margin-top:12px">Deposit Resolved</div>
          ${refunded.map(([item, type]) => _renderPayCard(item, type, false)).join('')}`;
      }
      html += `</div>`;
    }
    return `<div style="padding:12px 16px 14px">${html}</div>`;
  }

  // Real payment: create a Stripe Checkout Session for this booking's deposit
  // and hand the browser off to Stripe's own hosted page (full redirect, not
  // the local iframe modal) - Stripe verifies the card, then the webhook
  // (backend/controllers/stripe.controller.js) confirms the booking itself.
  async function startStripeCheckout(btn, id, payKey) {
    if (!id) return;
    const base = payKey === 'move' ? '/api/move' : '/api/booking';
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Redirecting…';
    try {
      const res  = await fetch(`${base}/${encodeURIComponent(id)}/checkout-session`, { method: 'POST' });
      const data = await res.json();
      // A prior click may have already been paid (Stripe confirmed it before
      // our webhook did) - that's good news, not a failure, so it gets its
      // own success path instead of falling into the generic error toast.
      if (data.success && data.alreadyPaid) {
        toast(data.message || 'This deposit has already been paid.', 'ok');
        btn.disabled = false; btn.textContent = orig;
        loadPayments();
        return;
      }
      if (!data.success || !data.url) {
        toast(data.message || 'Could not start checkout. Please try again.', 'err');
        btn.disabled = false; btn.textContent = orig;
        return;
      }
      window.location.href = data.url; // leaves the SPA for Stripe's hosted page
    } catch {
      toast('Connection error starting checkout. Please try again.', 'err');
      btn.disabled = false; btn.textContent = orig;
    }
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
      // Both are real backends now (booking.controller.js / move.controller.js) -
      // resident-scoped, with the live status + id, so anything that shows in
      // My Bookings/My Move Bookings also shows here. No per-fetch .catch() here
      // on purpose - a genuine failure must reach the outer catch and show the
      // "Could not load" error below, not silently resolve to {} and render as
      // if there were simply no deposits (a resident could miss a real pending one).
      const [bRes, mRes] = await Promise.all([
        fetch(`/api/booking/mine?${qs.toString()}`).then(r => r.json()),
        fetch('/api/move/mine').then(r => r.json()),
      ]);
      if (!bRes.success || !mRes.success) throw new Error('payments fetch failed');
      const facItems = (bRes.items || [])
        .filter(b => b.oppId && DEPOSIT_FACILITY_KEYS.has(b.facilityKey))
        .map(b => ({ id: b.oppId, stage: b.stage, depositDueAt: b.depositDueAt || '', depositStatus: b.depositStatus || 'none', depositNote: b.depositNote || '', facilityKey: b.facilityKey, name: [b.facility || b.facilityKey, b.date, b.slot].filter(Boolean).join(' - ') }));
      const moveItems = (mRes.items || [])
        .map(m => ({ id: m.moveId, stage: m.status, depositDueAt: m.depositDueAt || '', depositStatus: m.depositStatus || 'none', depositNote: m.depositNote || '', name: [m.moveType, m.moveDate, m.moveTime].filter(Boolean).join(' - ') }));

      const pending = [
        ...facItems.filter(o => DEPOSIT_STAGES.has(o.stage)).map(o => [o, 'facility']),
        ...moveItems.filter(o => DEPOSIT_STAGES.has(o.stage)).map(o => [o, 'move']),
      ];
      // Bucketed by the deposit's OWN state, not the booking/move's stage - a
      // cancelled booking whose deposit is still 'held' (money not yet refunded
      // or forfeited) must still show up here, not disappear from Payments
      // entirely just because the underlying booking is no longer Confirmed.
      const confirmed = [
        ...facItems.filter(o => o.depositStatus === 'held').map(o => [o, 'facility']),
        ...moveItems.filter(o => o.depositStatus === 'held').map(o => [o, 'move']),
      ];
      const refunded = [
        ...facItems.filter(o => o.depositStatus === 'refunded' || o.depositStatus === 'forfeited').map(o => [o, 'facility']),
        ...moveItems.filter(o => o.depositStatus === 'refunded' || o.depositStatus === 'forfeited').map(o => [o, 'move']),
      ];
      // Poll re-renders this panel wholesale every 7s (see setInterval below) -
      // without this, a resident who collapses Payment History would see it
      // silently snap back open on the next tick since a fresh .pay-history-body
      // always starts expanded (no `hidden` attr in _renderPayBlock's markup).
      const prevHistoryBody = el.querySelector('.pay-history-body');
      const historyWasHidden = !!(prevHistoryBody && prevHistoryBody.hidden);
      el.innerHTML = _renderPayBlock(pending, confirmed, refunded);
      if (historyWasHidden) {
        const body = el.querySelector('.pay-history-body');
        if (body) body.hidden = true;
        const arrow = el.querySelector('.pay-history-toggle .phi');
        if (arrow) arrow.textContent = '▸';
      }
      // Every deposit facility + Move-In/Out now pays through a real Stripe
      // Checkout Session - the webhook confirms it, not a self-reported "done" click.
      el.querySelectorAll('[data-pay-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          const payKey = btn.dataset.payKey || '';
          const oppId  = btn.dataset.oppId  || '';
          startStripeCheckout(btn, oppId, payKey);
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

  // Messages (resident ↔ management) - wired to the shared inbox design
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
        // Real read receipt: a resident message is "read" once management's
        // last-read timestamp is at/after it (or they've since replied).
        const mgmtReadAt = (data.conversation && data.conversation.management_last_read_at) ? new Date(data.conversation.management_last_read_at).getTime() : 0;
        let html = '', lastDay = '';
        msgs.forEach((m, i) => {
          const day = msgDayLabel(m.createdAt);
          if (day !== lastDay) { html += `<div class="inbox__date-sep"><span>${esc(day)}</span></div>`; lastDay = day; }
          const out = m.sender === 'resident';
          let statusIcon = '';
          if (out) {
            const hasReplyAfter = msgs.slice(i + 1).some(m2 => m2.sender !== 'resident');
            const isRead = hasReplyAfter || (mgmtReadAt && mgmtReadAt >= new Date(m.createdAt).getTime());
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
  // Compose bar
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

  // Feedback helpers + other forms
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

  // Inline field validation
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

  // Move date validation helpers
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
        body: JSON.stringify({ moveType: move_type, moveDate: move_date, moveTime: move_time, notes }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg('moveMsg', '');
        $('moveNotes').value = '';
        loadMyMoves();
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
    const ic             = $('gVisitorIc') ? $('gVisitorIc').value.trim() : '';
    const vehicle        = $('gVehicle')   ? $('gVehicle').value.trim()   : '';
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
    const editing = _editingGuestId;
    const reviewRows = [
      ['Visitor Type', visitorType],
      ['Name',         name],
      ['Email',        email],
      ['Phone',        phone || ''],
      ['IC / Passport', ic || ''],
      ['Vehicle',      vehicle || ''],
      ['Visit Date',   fmtDate(date)],
      ['Duration',     duration],
    ];
    if (!editing && linkedBooking) reviewRows.push(['Linked Booking', `${linkedBooking.emoji || ''} ${linkedBooking.facilityName} · ${fmtDate(linkedBooking.date)}`]);
    const { isConfirmed: gOk } = await swalReview(editing ? 'Review Changes' : 'Review Visitor Registration', reviewRows, null);
    if (!gOk) return;
    const btn = $('gRegisterBtn');
    setMsg('gMsg', editing ? 'Saving…' : 'Registering…'); btn.disabled = true;
    try {
      const res = await fetch(editing ? `/api/guest/${encodeURIComponent(editing)}` : '/api/guest', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitor_type: visitorType, visitor_name: name, visitor_email: email, visitor_phone: phone,
          visitor_ic: ic, visitor_vehicle: vehicle,
          visit_date: date, duration,
          // Linked booking is set once at registration and not editable here.
          linked_booking_id: editing ? undefined : (linkedBookingId || undefined),
          linked_facility:   editing ? undefined : (linkedBooking ? linkedBooking.facilityName : undefined),
          linked_date:       editing ? undefined : (linkedBooking ? linkedBooking.date         : undefined),
          host_name: member.name, host_email: member.email, host_unit: member.unit, host_contact_id: member.contact_id,
        }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('gMsg', data.message || (editing ? 'Could not save changes.' : 'Registration failed.'), true); return; }
      setMsg('gMsg', '');
      if (editing) {
        swalDone('Visitor Updated', [
          ['Visitor',    name],
          ['Type',       visitorType],
          ['Visit Date', fmtDate(date)],
          ['Reference',  data.reference || ''],
        ], 'Your changes are saved. The pass reference is unchanged.');
      } else {
        swalDone('Visitor Registered', [
          ['Visitor',    name],
          ['Type',       visitorType],
          ['Visit Date', fmtDate(date)],
          ['Reference',  data.reference || ''],
        ], 'The guardhouse has been notified.' + (data.reference ? ` Pass ref: ${data.reference}.` : ''));
      }
      exitGuestEditMode();
      $('gVisitorType').value = '';
      if ($('gLinkedBooking')) { $('gLinkedBooking').value = ''; updateGuestBookingStatus(); }
      clr(['gVisitorName', 'gVisitorEmail', 'gVisitorPhone', 'gVisitorIc', 'gVehicle']);
      const gPanel = $('myGuestsList');
      if (gPanel) gPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyGuests(), 3000);
    } catch {
      setMsg('gMsg', 'Something went wrong. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  bind('gResetBtn', () => { exitGuestEditMode(); $('gVisitorType').value = ''; $('gLinkedBooking').value = ''; clr(['gVisitorName', 'gVisitorEmail', 'gVisitorPhone', 'gVisitorIc', 'gVehicle']); setMsg('gMsg', ''); updateGuestBookingStatus(); });
  if ($('gLinkedBooking')) $('gLinkedBooking').addEventListener('change', updateGuestBookingStatus);
  document.querySelectorAll('[data-view="guests"]').forEach(el => el.addEventListener('click', populateBookingSelector));

  // Fill the (previously empty) defect stage legend so residents can see the
  // lifecycle their report moves through.
  (function fillDefectStages() {
    const el = $('defectStages');
    if (!el) return;
    const stages = ['Reported', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'];
    el.innerHTML = stages
      .map(s => `<span class="stage-pill">${esc(s)}</span>`)
      .join('<span class="stage-pill-sep">›</span>');
  })();

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
      try {
        defect_file = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read'));
          reader.onload = e => {
            const img = new Image();
            img.onerror = () => reject(new Error('decode'));
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
      } catch {
        // Distinguish an unreadable image from a network failure — the outer
        // submit catch would otherwise mislabel this as "Connection error".
        setMsg('dMsg', "Couldn't read that image. Try a different photo, or submit without one.", true);
        return;
      }
    }
    const editing = _editingDefectId;
    const catDisplay = secondaryCategory ? `${category} + ${secondaryCategory}` : category;
    const { isConfirmed: dOk } = await swalReview(editing ? 'Review Changes' : 'Review Defect Report', [
      ['Category', catDisplay || ''],
      ['Urgency',  urgency  || ''],
      ['Location', location || ''],
      ['Unit',     member?.unit || ''],
    ], desc);
    if (!dOk) return;
    const btn = $('dSubmitBtn');
    setMsg('dMsg', editing ? 'Saving…' : 'Submitting…'); btn.disabled = true;
    try {
      // Defects are a real Mongo-backed endpoint — create (POST) or, while the
      // report is still 'Reported', edit it in place (PUT /api/defect/:id).
      const res = await fetch(editing ? `/api/defect/${encodeURIComponent(editing)}` : '/api/defect', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, location, category, secondaryCategory, urgency, defect_file, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('dMsg', data.message || (editing ? 'Could not save changes.' : 'Submission failed.'), true); return; }
      setMsg('dMsg', '');
      exitDefectEditMode();
      swalDone(editing ? 'Report Updated' : 'Report Submitted', [
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
      setTimeout(() => loadMyDefects(), 300);
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
    exitDefectEditMode();
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
    const editing = _editingParcelId;
    const { isConfirmed: pcOk } = await swalReview(editing ? 'Review Changes' : 'Notify Guardhouse', [
      ['Parcel Ref',          ref],
      ['Courier/Sender',      courier   || ''],
      ['Description',         desc      || ''],
      ['Authorized Collector', collector || ''],
      ['Unit',                member?.unit || ''],
    ], null);
    if (!pcOk) return;
    const btn = $('pcSubmitBtn');
    setMsg('pcMsg', editing ? 'Saving…' : 'Notifying…'); btn.disabled = true;
    try {
      // Parcels are a real Mongo-backed endpoint — create (POST) or, while still
      // 'Notified', edit in place (PUT /api/parcel/:id).
      const res = await fetch(editing ? `/api/parcel/${encodeURIComponent(editing)}` : '/api/parcel', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcel_reference: ref, courier, description: desc, authorized_collector: collector, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('pcMsg', data.message || (editing ? 'Could not save changes.' : 'Submission failed.'), true); return; }
      if (data.duplicate) {
        setMsg('pcMsg', '');
        window.Swal?.fire({ icon: 'info', title: 'Already Logged', text: `Parcel reference "${ref}" is already on record with the guardhouse.`, confirmButtonText: 'OK', confirmButtonColor: '#312e81' });
        return;
      }
      setMsg('pcMsg', '');
      exitParcelEditMode();
      swalDone(editing ? 'Parcel Updated' : 'Guardhouse Notified', [
        ['Parcel Ref',          ref],
        ['Courier/Sender',      courier   || ''],
        ['Authorized Collector', collector || ''],
        ['Unit',                member?.unit || ''],
      ], editing ? 'Your changes are saved.' : 'The guardhouse will receive and hold your parcel. Please collect it within 7 days.');
      clr(['pcRef', 'pcCourier', 'pcDesc', 'pcCollector']);
      const pcPanel = $('parcelList');
      if (pcPanel) pcPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyParcels(), 300);
    } catch {
      setMsg('pcMsg', 'Connection error. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  bind('pcCancelBtn', () => { exitParcelEditMode(); clr(['pcRef', 'pcCourier', 'pcDesc', 'pcCollector']); setMsg('pcMsg', ''); });

  bind('fbSubmitBtn', async () => {
    const type     = $('fbType')     ? $('fbType').value     : '';
    const category = fbEffectiveCategory();
    const desc     = $('fbDesc').value.trim();
    // Incident date/time only apply to a Complaint (the form hides them otherwise).
    const fbDate   = (type === 'Complaint' && $('fbDate')) ? $('fbDate').value : '';
    const fbTime   = (type === 'Complaint' && $('fbTime')) ? $('fbTime').value : '';
    if (!desc) { setMsg('fbMsg', 'Please describe your submission.', true); return; }
    if (fbDate && fbDate > todaySGT()) { setMsg('fbMsg', 'The incident date cannot be in the future.', true); return; }
    // Optional evidence photo (compressed to a base64 data URL).
    let feedback_file = '';
    const fbPhotoInput = $('fbPhoto');
    if (fbPhotoInput && fbPhotoInput.files[0]) {
      setMsg('fbMsg', 'Compressing photo…');
      try { feedback_file = await compressImage(fbPhotoInput.files[0]); setMsg('fbMsg', ''); }
      catch { setMsg('fbMsg', "Couldn't read that image. Try a different photo, or submit without one.", true); return; }
    }
    const editing = _editingFeedbackId;
    const { isConfirmed: fbOk } = await swalReview(editing ? 'Review Changes' : `Review ${type || 'Submission'}`, [
      ['Type',     type     || ''],
      ['Category', category || ''],
      ['Date',     fbDate ? fmtDate(fbDate) : ''],
      ['Time',     fbTime  || ''],
    ], desc);
    if (!fbOk) return;
    const btn = $('fbSubmitBtn');
    setMsg('fbMsg', editing ? 'Saving…' : 'Submitting…'); btn.disabled = true;
    try {
      // Feedback is a real Mongo-backed endpoint — create (POST) or, while still
      // 'Submitted', edit in place (PUT /api/feedback/:id).
      const res = await fetch(editing ? `/api/feedback/${encodeURIComponent(editing)}` : '/api/feedback', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, category, description: desc, incident_date: fbDate, incident_time: fbTime, feedback_file, resident_name: member.name, resident_email: member.email, resident_unit: member.unit, resident_contact_id: member.contact_id }),
      });
      const data = await res.json();
      if (!data.success) { setMsg('fbMsg', data.message || (editing ? 'Could not save changes.' : 'Submission failed.'), true); return; }
      setMsg('fbMsg', '');
      exitFeedbackEditMode();
      swalDone(editing ? 'Submission Updated' : `${type || 'Submission'} Received`, [
        ['Reference', data.reference || ''],
        ['Type',     type     || ''],
        ['Category', category || ''],
        ['Date',     fbDate ? fmtDate(fbDate) : ''],
        ['Unit',     member?.unit || ' - '],
      ], editing ? 'Your changes are saved.' : `Thank you. Management will review your submission and respond shortly.${data.reference ? ` Your reference is ${data.reference}.` : ''}`);
      clr(['fbDesc', 'fbDate', 'fbTime']);
      updateFbDescCount();
      if ($('fbCategoryOther')) $('fbCategoryOther').value = '';
      if ($('fbCategory')) $('fbCategory').selectedIndex = 0;
      toggleFbOther();
      if ($('fbPhoto')) { $('fbPhoto').value = ''; const n = $('fbPhotoName'); if (n) { n.textContent = 'Choose a photo…'; n.classList.remove('has-file'); } }
      const fbPanel = $('myFeedback');
      if (fbPanel) fbPanel.innerHTML = '<div class="panel-empty">Processing your submission, please wait…</div>';
      setTimeout(() => loadMyFeedback(), 300);
    } catch {
      setMsg('fbMsg', 'Connection error. Please try again.', true);
    } finally { btn.disabled = false; }
  });
  bind('fbCancelBtn', () => {
    exitFeedbackEditMode();
    clr(['fbDesc', 'fbDate', 'fbTime']);
    updateFbDescCount();
    if ($('fbCategoryOther')) $('fbCategoryOther').value = '';
    toggleFbOther();
    if ($('fbPhoto')) { $('fbPhoto').value = ''; const n = $('fbPhotoName'); if (n) { n.textContent = 'Choose a photo…'; n.classList.remove('has-file'); } }
    setMsg('fbMsg', '');
  });

  // Panel refresh buttons
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

  // Resources
  const CATEGORY_ICONS = {
    'By-Laws':         'gavel',
    'Fire Safety':     'local_fire_department',
    'Meeting Minutes': 'event_note',
    'Strata Title Plan': 'map',
    'Other':           'description',
  };
  // Category display order — regulatory documents first, general reference last.
  const CATEGORY_ORDER = ['By-Laws', 'Fire Safety', 'Meeting Minutes', 'Strata Title Plan', 'Other'];

  const EXT_FROM_MIME = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'image/jpeg': 'JPG', 'image/png': 'PNG', 'text/plain': 'TXT',
  };
  function _fileExt(fileName, fileType) {
    const fromName = String(fileName || '').split('.').pop();
    if (fromName && fromName.length <= 5 && fromName !== fileName) return fromName.toUpperCase();
    return EXT_FROM_MIME[fileType] || 'FILE';
  }

  function _resDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
  }

  function _resEmptyState(icon, title, sub) {
    return `<div class="notices-empty">
      <span class="material-symbols-outlined notices-empty__icon">${esc(icon)}</span>
      <div class="notices-empty__title">${esc(title)}</div>
      <div class="notices-empty__sub">${esc(sub)}</div>
    </div>`;
  }

  const RES_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // "NEW" badge for docs published in the last 7 days
  let _resourceDocs = [];

  async function loadResources(silent) {
    const container = $('resourcesContainer');
    if (!container) return;
    if (!silent) container.innerHTML = _resEmptyState('hourglass_top', 'Loading documents…', 'Fetching the latest building documents.');
    try {
      const res  = await fetch('/api/resources');
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Failed to load resources.');
      _resourceDocs = data.resources || [];
      _renderResources($('resSearchInput')?.value || '');
    } catch (err) {
      container.innerHTML = _resEmptyState('error_outline', 'Couldn’t load documents', err.message || 'Something went wrong. Please try again.');
    }
  }

  function _renderResources(searchTerm) {
    const container = $('resourcesContainer');
    if (!container) return;
    const q = (searchTerm || '').trim().toLowerCase();
    const docs = q
      ? _resourceDocs.filter(d => d.title.toLowerCase().includes(q) || (d.category || '').toLowerCase().includes(q))
      : _resourceDocs;

    if (!_resourceDocs.length) {
      container.innerHTML = _resEmptyState('folder_open', 'No documents yet', 'Management will publish by-laws, fire safety guidelines, meeting minutes, and other building documents here.');
      return;
    }
    if (!docs.length) {
      container.innerHTML = _resEmptyState('search_off', 'No matching documents', `Nothing matches "${searchTerm}". Try a different search.`);
      return;
    }
    // Group by category, in a fixed regulatory-first order
    const groups = {};
    docs.forEach(d => {
      const cat = d.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(d);
    });
    const orderedCats = [...CATEGORY_ORDER.filter(c => groups[c]), ...Object.keys(groups).filter(c => !CATEGORY_ORDER.includes(c))];
    container.innerHTML = orderedCats.map(cat => {
      const items = groups[cat];
      return `
      <div class="res-group">
        <div class="res-group-header">
          <span class="material-symbols-outlined res-group-icon">${esc(CATEGORY_ICONS[cat] || 'description')}</span>
          <span class="res-group-name">${esc(cat)}</span>
          <span class="res-group-count">${items.length}</span>
        </div>
        <div class="res-group-items">
          ${items.map(d => {
            const isNew = d.createdAt && (Date.now() - new Date(d.createdAt).getTime()) < RES_NEW_WINDOW_MS;
            return `
            <div class="res-item">
              <span class="res-item-ext">${esc(_fileExt(d.file_name, d.file_type))}</span>
              <div class="res-item-info">
                <span class="res-item-title">${esc(d.title)}${isNew ? '<span class="res-new-badge">New</span>' : ''}</span>
                <span class="res-item-meta">${d.file_size ? _fmtSize(d.file_size) + ' · ' : ''}Updated ${esc(_resDate(d.createdAt))}</span>
              </div>
              <div class="res-item-actions">
                <button class="res-view-btn" data-res-id="${esc(d.id)}" data-title="${esc(d.title)}" data-file-name="${esc(d.file_name)}" data-file-type="${esc(d.file_type)}" aria-label="View ${esc(d.title)}" title="View">
                  <span class="material-symbols-outlined">visibility</span>
                </button>
                <button class="res-download-btn" data-res-id="${esc(d.id)}" data-file-name="${esc(d.file_name)}" data-file-type="${esc(d.file_type)}" aria-label="Download ${esc(d.title)}">
                  <span class="material-symbols-outlined">download</span> Download
                </button>
              </div>
            </div>
          `;
          }).join('')}
        </div>
      </div>`;
    }).join('');
    // Attach handlers
    container.querySelectorAll('.res-download-btn').forEach(btn => {
      btn.addEventListener('click', () => _downloadResource(btn.dataset.resId, btn.dataset.fileName, btn.dataset.fileType, btn));
    });
    container.querySelectorAll('.res-view-btn').forEach(btn => {
      btn.addEventListener('click', () => _viewResource(btn.dataset.resId, btn.dataset.title, btn.dataset.fileName, btn.dataset.fileType, btn));
    });
  }

  (() => {
    const input = $('resSearchInput');
    if (input) input.addEventListener('input', () => _renderResources(input.value));
  })();

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
      toast('Download failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  // Opens the document in an in-page modal (not a new tab) using an iframe -
  // the browser's native PDF/image viewer renders inside it either way.
  async function _viewResource(id, title, fileName, fileType, btn) {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span>';
    try {
      const res  = await fetch(`/api/resources/${encodeURIComponent(id)}/download`);
      const data = await res.json();
      if (!data.success || !data.file_data) throw new Error(data.message || 'Could not open document.');
      const blobUrl = _dataUrlToBlobUrl(data.file_data, data.file_type || fileType);
      _openPreviewModal(blobUrl, title || fileName);
    } catch (err) {
      toast('Could not open document: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  let _previewBlobUrl = null;
  function _openPreviewModal(blobUrl, title) {
    const modal = $('resPreviewModal');
    const frame = $('resPreviewFrame');
    if (!modal || !frame) return;
    if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
    _previewBlobUrl = blobUrl;
    frame.src = blobUrl;
    const titleEl = $('resPreviewTitle');
    if (titleEl) titleEl.textContent = title || 'Document';
    modal.classList.add('open');
  }
  function _closePreviewModal() {
    const modal = $('resPreviewModal');
    const frame = $('resPreviewFrame');
    if (modal) modal.classList.remove('open');
    if (frame) frame.src = 'about:blank';
    if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
  }
  (() => {
    const modal = $('resPreviewModal');
    if (!modal) return;
    bind('resPreviewClose', _closePreviewModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) _closePreviewModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) _closePreviewModal(); });
  })();

  function _dataUrlToBlobUrl(dataUrl, fallbackMime) {
    const comma = dataUrl.indexOf(',');
    const isDataUrl = dataUrl.startsWith('data:');
    const mime = isDataUrl ? dataUrl.slice(5, comma).split(';')[0] : (fallbackMime || 'application/octet-stream');
    const base64 = isDataUrl ? dataUrl.slice(comma + 1) : dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
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

  bind('logoutBtn', () => {
    _rawFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'resident' }) }).catch(() => {}); // clear the cookie server-side
    [SESS, 'portalLastView'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    _broadcastLogout();
    window.location.href = 'index.html';
  });

  // Mobile sidebar toggle
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
  // The token itself lives in an httpOnly cookie now (invisible to this JS), so
  // stored member info is the only client-side signal that a session might exist;
  // if the cookie's actually gone/expired, the first real API call 401s and
  // handleAuthExpired() bounces back to login.
  try { member = JSON.parse(sessionStorage.getItem(SESS) || localStorage.getItem(SESS) || 'null'); } catch {}
  if (member) bootPortal();
  else $('loginEmail').focus(); // land keyboard focus straight on the first field

  // Returning from Stripe Checkout (see startStripeCheckout) - clean the URL so
  // refreshing/re-sharing the link can't be mistaken for a fresh payment, then
  // land on Payments so the resident sees their booking update. The webhook
  // usually beats this redirect back, but loadPayments()'s own poll will pick
  // up the confirmed status within seconds either way if it hasn't yet.
  const _paidParam = new URLSearchParams(location.search).get('paid');
  if (_paidParam !== null) {
    history.replaceState({}, '', location.pathname);
    if (member) {
      navigate('payments');
      toast(_paidParam === '1' ? 'Payment received - confirming your booking…' : 'Checkout cancelled - your deposit is still pending.', _paidParam === '1' ? 'ok' : 'err');
    }
  }

})();
