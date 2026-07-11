(function () {
  'use strict';

  // management.controller.js  (served at /js/management.controller.js)
  // Client-side controller for management.html.
  // Requires a management session (set by the login page). Data tables show
  // empty states until the data API is rebuilt; view switching, the modal, and
  // logout all work.

  const $ = id => document.getElementById(id);

  // Session gate — the actual credential lives in an httpOnly cookie now;
  // mgmtUser is just the display-info signal that a session exists. If the
  // cookie's actually gone/expired, this page's own API calls will 401.
  let USER = {};
  try { USER = JSON.parse(sessionStorage.getItem('mgmtUser') || localStorage.getItem('mgmtUser') || '{}'); } catch {}
  if (!USER.username) { window.location.href = 'management-login.html'; return; }
  // Every data view below still attaches this to its mock API calls, which
  // ignore it entirely (the mock doesn't check headers) - kept as a harmless
  // placeholder so those existing call sites don't need touching.
  const token = 'session';

  // Hide the full-screen loading overlay (covers everything by default)
  const overlay = $('loadingOverlay');
  if (overlay) { overlay.style.opacity = '0'; setTimeout(() => { overlay.style.display = 'none'; }, 420); }

  // Identity + date
  if (USER.username && $('userName'))   $('userName').textContent = USER.username;
  if (USER.username && $('userAvatar')) $('userAvatar').textContent = USER.username[0].toUpperCase();
  $('topbarDate').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore',
  });

  // Toast
  let _t;
  function toast(msg, isErr) {
    const el = $('toast'); if (!el) return;
    el.textContent = msg; el.className = 'show ' + (isErr ? 'error' : 'success');
    clearTimeout(_t); _t = setTimeout(() => { el.className = ''; }, 3500);
  }

  // Mobile sidebar toggle
  const sidebar        = document.querySelector('.sidebar');
  const sidebarOverlay = $('sidebarOverlay');
  const sidebarToggle  = $('sidebarToggle');
  function closeSidebar() {
    sidebar?.classList.remove('open');
    sidebarOverlay?.classList.remove('open');
  }
  sidebarToggle?.addEventListener('click', () => {
    const isOpen = sidebar?.classList.toggle('open');
    sidebarOverlay?.classList.toggle('open', isOpen);
  });
  sidebarOverlay?.addEventListener('click', closeSidebar);

  // Theme toggle
  (function initTheme() {
    const KEY = 'lumina-portal-theme';
    function syncToggleUI(theme) {
      document.querySelectorAll('[data-theme-toggle]').forEach(el => {
        el.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
      });
    }
    syncToggleUI(document.documentElement.dataset.theme || 'dark');
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        localStorage.setItem(KEY, next);
        syncToggleUI(next);
      });
    });
  })();

  // Table scroll wrappers (enables horizontal scroll without breaking full-width columns)
  document.querySelectorAll('table.data-table').forEach(t => {
    const w = document.createElement('div');
    w.className = 'table-scroll';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });

  // View / tab switching
  function navigate(view) {
    document.querySelectorAll('.nav__item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
    window.scrollTo(0, 0);
    localStorage.setItem('mgmtLastView', view);
    closeSidebar();
  }
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.view)));
  navigate(localStorage.getItem('mgmtLastView') || 'dashboard');

  // Dashboard date tabs
  let _dashPeriod = 'today';
  const dateTabs = $('dashDateTabs');
  if (dateTabs) {
    dateTabs.querySelectorAll('.date-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        dateTabs.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _dashPeriod = tab.dataset.period || 'today';
        _refreshDashKpis();
      });
    });
  }

  // Buttons (validate + feedback; data not wired)
  bind('refreshBtn', () => {
    const b = $('refreshBtn'); if (!b) return;
    b.disabled = true; b.textContent = '⟲ Refreshing…';
    Promise.allSettled([loadBookings(), loadGuests(), loadDefects(), loadParcels(), loadMoves(), loadFeedback(), loadContacts(), loadAnnouncements(), loadConversations(), loadPaymentsPanel()])
      .then(() => toast('Data refreshed.'))
      .finally(() => { b.disabled = false; b.textContent = '⟲ REFRESH'; });
  });
  // Announcement event date/time controls
  // Time dropdowns: 30-min slots, value "HH:MM" (24h), label 12h. The Lumina runs
  // on Asia/Singapore, so we anchor the combined instant to +08:00 on submit.
  const SGT_OFFSET = '+08:00';
  function fillTimeOptions(sel, blankLabel) {
    if (!sel) return;
    let html = `<option value="">${blankLabel}</option>`;
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const val   = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const hr12  = (h % 12) || 12;
        const label = `${hr12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
        html += `<option value="${val}">${label}</option>`;
      }
    }
    sel.innerHTML = html;
  }
  ['annEventTime', 'annEventEndTime', 'annStartTime', 'annEndTime'].forEach(id => fillTimeOptions($(id), 'Time'));
  // Combine a date input ("YYYY-MM-DD") + time select ("HH:MM") into an SGT ISO string.
  const combineDateTime = (date, time) => (date && time) ? `${date}T${time}:00${SGT_OFFSET}` : '';
  // Show maintenance start/end fields only for the Maintenance category.
  function syncAnnCategoryFields() {
    const cat     = $('annCategory') ? $('annCategory').value : '';
    const isMaint = cat === 'Maintenance';
    const isEvent = cat === 'Event';
    if ($('annEventRow'))  $('annEventRow').style.display  = isMaint ? 'none' : '';
    if ($('annMaintRows')) $('annMaintRows').style.display = isMaint ? '' : 'none';
    if ($('annRsvpRow'))   $('annRsvpRow').style.display   = isEvent ? '' : 'none';
    if (!isEvent && $('annRsvp')) $('annRsvp').checked = false;
    if ($('annBlockRow'))  $('annBlockRow').style.display  = (isEvent || isMaint) ? '' : 'none';
    if ($('annBlockRowLabel')) $('annBlockRowLabel').textContent = isEvent
      ? 'Select the venue for this event'
      : 'Block these facilities during maintenance';
    if ($('annBlockOtherLabel')) $('annBlockOtherLabel').style.display = isEvent ? 'flex' : 'none';
    if (!isEvent && !isMaint) {
      document.querySelectorAll('input[name="annBlock"]').forEach(cb => cb.checked = false);
      if ($('annBlockOther')) $('annBlockOther').checked = false;
      if ($('annVenueOther')) $('annVenueOther').style.display = 'none';
    }
    if (!isEvent) {
      if ($('annBlockOther')) $('annBlockOther').checked = false;
      if ($('annVenueOther')) { $('annVenueOther').style.display = 'none'; $('annVenueOther').value = ''; }
    }
  }
  if ($('annCategory')) $('annCategory').addEventListener('change', syncAnnCategoryFields);
  syncAnnCategoryFields();

  if ($('annBlockOther')) {
    $('annBlockOther').addEventListener('change', () => {
      if ($('annVenueOther')) $('annVenueOther').style.display = $('annBlockOther').checked ? '' : 'none';
      if (!$('annBlockOther').checked && $('annVenueOther')) $('annVenueOther').value = '';
    });
  }

  bind('annPostBtn', async () => {
    const title = $('annTitle').value.trim(), body = $('annBody').value.trim();
    const category = $('annCategory') ? $('annCategory').value : 'General';
    const pinned = $('annPinned') ? $('annPinned').checked : false;
    if (!title || !body) { $('annMsg').textContent = 'Title and body are required.'; return; }

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    const isPast = d => d && d < todayStr;
    let eventAt = '', eventEndAt = '';
    if (category === 'Maintenance') {
      const sd = $('annStartDate').value, ed = $('annEndDate').value;
      if (isPast(sd) || isPast(ed)) { $('annMsg').textContent = 'Dates cannot be in the past.'; return; }
      eventAt    = combineDateTime(sd, $('annStartTime').value);
      eventEndAt = combineDateTime(ed, $('annEndTime').value);
      if (!eventAt || !eventEndAt) { $('annMsg').textContent = 'Maintenance needs a start and end date & time.'; return; }
      if (new Date(eventEndAt) < new Date(eventAt)) { $('annMsg').textContent = 'Maintenance end must be after the start.'; return; }
    } else {
      const d = $('annEventDate').value, t = $('annEventTime').value;
      const et = $('annEventEndTime') ? $('annEventEndTime').value : '';
      if (isPast(d)) { $('annMsg').textContent = 'Event date cannot be in the past.'; return; }
      eventAt = combineDateTime(d, t);
      if ((d && !t) || (!d && t)) { $('annMsg').textContent = 'Please set both a date and a time for the event.'; return; }
      if (et) {
        eventEndAt = combineDateTime(d, et);
        if (eventAt && new Date(eventEndAt) <= new Date(eventAt)) { $('annMsg').textContent = 'Event end time must be after the start time.'; return; }
      }
      const blocked = [...document.querySelectorAll('input[name="annBlock"]:checked')].map(cb => cb.value);
      if (blocked.length && (!eventAt || !eventEndAt)) { $('annMsg').textContent = 'Please set a start and end time when blocking facilities.'; return; }
    }

    const blocked_facilities = (category === 'Event' || category === 'Maintenance')
      ? [...document.querySelectorAll('input[name="annBlock"]:checked')].map(cb => cb.value)
      : [];
    const event_venue = (category === 'Event' && $('annBlockOther')?.checked)
      ? ($('annVenueOther')?.value.trim() || '')
      : '';

    const btn = $('annPostBtn'); btn.disabled = true; $('annMsg').textContent = 'Publishing…';
    try {
      const res = await fetch('/api/management/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, body, category, pinned, rsvp_enabled: ($('annRsvp') ? $('annRsvp').checked : false) && category === 'Event', blocked_facilities, event_venue: event_venue || undefined, eventAt: eventAt || undefined, eventEndAt: eventEndAt || undefined }),
      });
      const data = await res.json();
      if (!data.success) { $('annMsg').textContent = data.message || 'Could not publish.'; return; }
      $('annMsg').textContent = '';
      $('annTitle').value = ''; $('annBody').value = ''; if ($('annPinned')) $('annPinned').checked = false;
      ['annEventDate', 'annEventTime', 'annEventEndTime', 'annStartDate', 'annStartTime', 'annEndDate', 'annEndTime'].forEach(id => { if ($(id)) $(id).value = ''; });
      document.querySelectorAll('input[name="annBlock"]').forEach(cb => cb.checked = false);
      if ($('annBlockOther')) $('annBlockOther').checked = false;
      if ($('annVenueOther')) { $('annVenueOther').value = ''; $('annVenueOther').style.display = 'none'; }
      toast('Announcement published.');
      loadAnnouncements().catch(() => {});
    } catch {
      $('annMsg').textContent = 'Connection error. Please try again.';
    } finally { btn.disabled = false; }
  });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  if ($('guestDate')) { $('guestDate').value = today; $('guestDate').min = today; }

  ['annEventDate', 'annStartDate', 'annEndDate'].forEach(id => { if ($(id)) $(id).min = today; });
  if ($('annStartDate') && $('annEndDate')) {
    $('annStartDate').addEventListener('change', () => {
      $('annEndDate').min = $('annStartDate').value || today;
      if ($('annEndDate').value && $('annEndDate').value < $('annEndDate').min) $('annEndDate').value = '';
    });
  }

  // Facility bookings - all residents, live from GHL
  function bkDateLabel(iso) {
    if (!iso) return ' - ';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  }
  function bkBadge(status) {
    const map = {
      'Deposit Pending': 'badge-submitted',    // amber
      'Confirmed':       'badge-confirmed',    // green
      'Completed':       'badge-resolved',     // green
      'No-Show':         'badge-uncollected',  // red
      'Cancelled':       'badge-closed',       // grey
    };
    const cls = map[status] || 'badge-default';
    return `<span class="badge ${cls}">${esc(status || 'Confirmed')}</span>`;
  }
  // Disabled (with a hint) when the booking has no linked pipeline opportunity yet.
  function bkStageSelect(b, stages) {
    if (!b.oppId) {
      return `<span class="bk-stage-none bk-syncing" title="Pipeline opportunity not yet created - auto-refreshing in a few seconds.">Syncing…</span>`;
    }
    const opts = stages.map(s => `<option value="${esc(s)}" ${s === b.stage ? 'selected' : ''}>${esc(s)}</option>`).join('');
    return `<select class="bk-stage-select" data-opp="${esc(b.oppId)}">${opts}</select>`;
  }
  // Set on first load to the bookings filter/search function, so every live refresh
  // can re-apply the manager's current filter instead of resetting it to "show all".
  let _applyBkFilter = null;
  async function loadBookings(silent) {
    const ts = $('bookingsTimestamp');
    if (ts && !silent) ts.textContent = 'Loading…';
    const res  = await fetch('/api/management/bookings', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.success) {
      if (ts) ts.textContent = 'Could not load bookings.';
      const body = $('bookingsBody');
      if (body) body.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(data.message || 'Could not load bookings.')}</td></tr>`;
      throw new Error(data.message || 'Failed to load bookings.');
    }
    const items  = data.items  || [];
    const stages = data.stages || ['Deposit Pending', 'Confirmed', 'Completed', 'No-Show', 'Cancelled'];

    const body = $('bookingsBody');
    if (body) {
      body.innerHTML = items.length
        ? items.map(b => `<tr>
            <td>${esc(b.facility)}</td>
            <td>${esc(b.resident || 'Resident')}</td>
            <td>${b.unit ? '#' + esc(b.unit) : ' - '}</td>
            <td>${esc(bkDateLabel(b.date))}</td>
            <td style="white-space:nowrap">${esc(b.slot)}</td>
            <td>${b.pax || 1}</td>
            <td>${bkBadge(b.stage)}</td>
            <td>${bkStageSelect(b, stages)}</td>
          </tr>`).join('')
        : `<tr class="empty-row"><td colspan="8">No facility bookings.</td></tr>`;
      // Wire each stage dropdown to update the linked opportunity in GHL.
      body.querySelectorAll('.bk-stage-select').forEach(sel => {
        sel.dataset.prev = sel.value;
        sel.addEventListener('change', async () => {
          const oppId = sel.dataset.opp, stage = sel.value;
          sel.disabled = true;
          try {
            const r = await fetch(`/api/management/bookings/${encodeURIComponent(oppId)}/stage`, {
              method:  'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body:    JSON.stringify({ stage }),
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.message || 'Update failed.');
            sel.dataset.prev = stage;
            const badge = sel.closest('tr').querySelector('.badge');
            if (badge) badge.outerHTML = bkBadge(stage);
            toast(`Moved to ${stage}.`);
          } catch (e) {
            sel.value = sel.dataset.prev;            // revert on failure
            toast(e.message || 'Could not update stage.', true);
          } finally {
            sel.disabled = false;
          }
        });
      });
    }
    if ($('bookingCount')) $('bookingCount').textContent = `${items.length} booking${items.length === 1 ? '' : 's'}`;

    // If any rows are still syncing (no opp linked yet), auto-refresh once after 12s
    if (body && body.querySelector('.bk-syncing')) {
      setTimeout(() => { if ($('bookingsBody')?.querySelector('.bk-syncing')) loadBookings(); }, 12000);
    }

    // Populate filter dropdowns on first load, then re-apply current filter
    const bkFacSel = $('bkFilterFacility');
    if (bkFacSel && bkFacSel.options.length === 1) {
      [...new Set(items.map(b => b.facility).filter(Boolean))].sort().forEach(f => bkFacSel.add(new Option(f, f)));
      const bkStaSel = $('bkFilterStatus');
      if (bkStaSel) stages.forEach(s => bkStaSel.add(new Option(s, s)));
      const bkFilter = () => {
        const q   = ($('bkSearch')?.value || '').toLowerCase();
        const fac = $('bkFilterFacility')?.value || '';
        const sta = $('bkFilterStatus')?.value || '';
        let n = 0;
        $('bookingsBody')?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const c = tr.querySelectorAll('td');
          const stage = c[6]?.querySelector('.badge')?.textContent.trim() || c[7]?.querySelector('select')?.value || '';
          const match = (!fac || c[0]?.textContent.trim() === fac) &&
                        (!sta || stage === sta) &&
                        (!q   || `${c[1]?.textContent} ${c[2]?.textContent}`.toLowerCase().includes(q));
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if ($('bookingCount')) $('bookingCount').textContent = `${n} booking${n === 1 ? '' : 's'}`;
      };
      ['bkSearch', 'bkFilterFacility', 'bkFilterStatus'].forEach(id => {
        $(id)?.addEventListener('input', bkFilter);
        $(id)?.addEventListener('change', bkFilter);
      });
      _applyBkFilter = bkFilter;
    }

    // Re-apply the manager's active filter/search so a live refresh doesn't reset it.
    if (_applyBkFilter) _applyBkFilter();

    // Cache for dashboard date-tab filtering.
    _allBookings = items;
    _refreshDashKpis();

    const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' });
    if (ts) ts.textContent = `Updated ${stamp}`;
    if ($('refreshNote')) $('refreshNote').textContent = `Live · updated ${stamp}`;
  }
  loadBookings().catch(e => console.error('[mgmt bookings]', e));
  document.querySelectorAll('[data-view="bookings"]').forEach(el =>
    el.addEventListener('click', () => loadBookings().catch(e => console.error('[mgmt bookings]', e))));

  // Live facility bookings
  // New bookings (and resident-side stage changes) appear without a manual page
  // refresh: poll fast while the Bookings view is open, plus a slower global cadence
  // so the dashboard KPIs stay fresh on other views. A tick is skipped when the
  // manager is mid-interaction (editing a stage select, or typing/filtering) so the
  // list isn't rebuilt under them, and overlapping polls are coalesced.
  function _bookingsBusy() {
    const a = document.activeElement;
    if (a && (a.classList?.contains('bk-stage-select') ||
              ['bkSearch', 'bkFilterFacility', 'bkFilterStatus'].includes(a.id))) return true;
    return !!$('bookingsBody')?.querySelector('.bk-stage-select[disabled]');  // a stage update in flight
  }
  let _bkPolling = false;
  async function _pollBookings() {
    if (_bkPolling || _bookingsBusy()) return;
    _bkPolling = true;
    try { await loadBookings(true); } catch {} finally { _bkPolling = false; }
  }
  // Honors the "Auto-refresh" setting for the global cadence.
  const _bkSecs = Math.max(30, parseInt(localStorage.getItem('mgmtRefreshSecs'), 10) || 90);
  setInterval(() => { if ($('view-bookings')?.classList.contains('active')) _pollBookings(); }, 15000);
  setInterval(_pollBookings, _bkSecs * 1000);
  // Refresh immediately on returning to the tab if a bookings-backed view is open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        ($('view-bookings')?.classList.contains('active') || $('view-dashboard')?.classList.contains('active'))) {
      _pollBookings();
    }
  });

  // Registered guests - all residents, live from GHL
  function gBadge(stage) {
    const map = {
      'Registered':  'badge-submitted',     // amber (new)
      'Checked In':  'badge-confirmed',      // green
      'Checked Out': 'badge-acknowledged',   // blue
      'Departed':    'badge-resolved',       // green
      'Closed':      'badge-closed',         // grey
    };
    return `<span class="badge ${map[stage] || 'badge-default'}">${esc(stage || 'Registered')}</span>`;
  }
  function gStageSelect(g, stages) {
    if (!g.oppId) return `<span class="bk-stage-none"> - </span>`;
    const opts = stages.map(s => `<option value="${esc(s)}" ${s === g.stage ? 'selected' : ''}>${esc(s)}</option>`).join('');
    return `<select class="bk-stage-select g-stage-select" data-opp="${esc(g.oppId)}">${opts}</select>`;
  }
  async function loadGuests() {
    const cnt = $('guestCount');
    if (cnt) cnt.textContent = 'Loading…';
    const res  = await fetch('/api/management/guests', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const body = $('guestsBody');
    if (!data.success) {
      if (cnt) cnt.textContent = '';
      if (body) body.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(data.message || 'Could not load guests.')}</td></tr>`;
      throw new Error(data.message || 'Failed to load guests.');
    }
    const items  = data.items  || [];
    const stages = data.stages || ['Registered', 'Checked In', 'Checked Out', 'Departed', 'Closed'];
    if (body) {
      body.innerHTML = items.length
        ? items.map(g => `<tr>
            <td>${esc(g.visitor)}</td>
            <td>${esc(g.host)}</td>
            <td>${g.unit ? '#' + esc(g.unit) : ''}</td>
            <td>${esc(g.phone || '')}</td>
            <td>${gBadge(g.stage)}</td>
            <td style="white-space:nowrap">${g.visitDate ? esc(bkDateLabel(g.visitDate)) : ''}</td>
            <td>${gStageSelect(g, stages)}</td>
          </tr>`).join('')
        : `<tr class="empty-row"><td colspan="7">No registered guests.</td></tr>`;
      body.querySelectorAll('.g-stage-select').forEach(sel => {
        sel.dataset.prev = sel.value;
        sel.addEventListener('change', async () => {
          const oppId = sel.dataset.opp, stage = sel.value;
          sel.disabled = true;
          try {
            const r = await fetch(`/api/management/guests/${encodeURIComponent(oppId)}/stage`, {
              method:  'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body:    JSON.stringify({ stage }),
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.message || 'Update failed.');
            sel.dataset.prev = stage;
            const badge = sel.closest('tr').querySelector('.badge');
            if (badge) badge.outerHTML = gBadge(stage);
            toast(`Guest moved to ${stage}.`);
          } catch (e) {
            sel.value = sel.dataset.prev;
            toast(e.message || 'Could not update guest.', true);
          } finally {
            sel.disabled = false;
          }
        });
      });
    }
    if (cnt) cnt.textContent = `${items.length} guest${items.length === 1 ? '' : 's'}`;
    _allGuests = items;
    _refreshDashKpis();

    const gsStaSel = $('gsFilterStage');
    if (gsStaSel && gsStaSel.options.length === 1) {
      stages.forEach(s => gsStaSel.add(new Option(s, s)));
      const gsFilter = () => {
        const q   = ($('gsSearch')?.value || '').toLowerCase();
        const sta = $('gsFilterStage')?.value || '';
        let n = 0;
        body?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const matchQ   = !q   || tr.textContent.toLowerCase().includes(q);
          const matchSta = !sta || (tr.querySelector('.g-stage-select')?.value === sta);
          const match = matchQ && matchSta;
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if (cnt) cnt.textContent = `${n} guest${n === 1 ? '' : 's'}`;
      };
      ['gsSearch', 'gsFilterStage'].forEach(id => {
        $(id)?.addEventListener('input', gsFilter);
        $(id)?.addEventListener('change', gsFilter);
      });
    }
  }
  loadGuests().catch(e => console.error('[mgmt guests]', e));
  document.querySelectorAll('[data-view="guests"]').forEach(el =>
    el.addEventListener('click', () => loadGuests().catch(e => console.error('[mgmt guests]', e))));

  // Generic pipeline panels (defect / parcel / move / feedback)
  function oppBadge(stage) {
    const slug = String(stage || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    return `<span class="badge badge-${slug || 'default'}">${esc(stage || '')}</span>`;
  }
  function urgencyBadge(u) {
    const key = String(u || '').toLowerCase().match(/emergency|urgent|routine/)?.[0] || 'routine';
    return `<span class="badge badge-${key}">${esc(u || 'Routine')}</span>`;
  }
  const urgencyRowClass = u => {
    const key = String(u || '').toLowerCase().match(/emergency|urgent|routine/)?.[0] || 'routine';
    return `row-urgency-${key}`;
  };
  function oppStageSelect(it, pipeline, stages) {
    if (!it.oppId) return `<span class="bk-stage-none"> - </span>`;
    const opts = stages.map(s => `<option value="${esc(s)}" ${s === it.stage ? 'selected' : ''}>${esc(s)}</option>`).join('');
    return `<select class="bk-stage-select" data-opp="${esc(it.oppId)}" data-pipeline="${esc(pipeline)}">${opts}</select>`;
  }
  // Loads a pipeline into a table body (cols: Reference · Stage · Contact · Unit · Date · Actions).
  async function loadPipelinePanel(pipeline, bodyId, countId) {
    const body = $(bodyId); if (!body) return;
    const res  = await fetch(`/api/management/opportunities?pipeline=${encodeURIComponent(pipeline)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.success) {
      body.innerHTML = `<tr class="empty-row"><td colspan="${pipeline === 'defect' ? 8 : 6}">${esc(data.message || 'Could not load.')}</td></tr>`;
      throw new Error(data.message || 'Failed to load.');
    }
    const items  = data.items  || [];
    const stages = data.stages || [];
    // Stages that count as finished (so we don't flag them as overdue).
    const DONE = ['Collected', 'Uncollected / Returned', 'Resolved', 'Closed', 'Completed', 'Departed', 'Cancelled'];
    const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0;
    const isDefect = pipeline === 'defect';
    body.innerHTML = items.length
      ? items.map(it => {
          const overdue = daysSince(it.createdAt) >= 7 && !DONE.includes(it.stage);
          const dateCell = it.createdAt
            ? `${esc(bkDateLabel(it.createdAt.slice(0, 10)))}${overdue ? ` <span class="badge badge-uncollected" title="Uncollected for 7+ days">7d+</span>` : ''}`
            : ' - ';
          const photoCell = isDefect
            ? (it.photo
                ? `<td><img src="${it.photo}" alt="defect photo" class="defect-thumb" data-photo="${esc(it.photo)}" title="Click to enlarge" /></td>`
                : '<td style="color:var(--text-muted,#9a9088)"> - </td>')
            : '';
          return `<tr class="${isDefect ? urgencyRowClass(it.urgency) : ''}">
            <td>${esc(it.reference)}</td>
            ${isDefect ? `<td>${urgencyBadge(it.urgency)}</td>` : ''}
            <td>${oppBadge(it.stage)}</td>
            <td>${esc(it.contact)}</td>
            <td>${it.unit ? '#' + esc(it.unit) : ' - '}</td>
            <td style="white-space:nowrap">${dateCell}</td>
            ${photoCell}
            <td>${oppStageSelect(it, pipeline, stages)}</td>
          </tr>`;
        }).join('')
      : `<tr class="empty-row"><td colspan="${isDefect ? 8 : 6}">No records.</td></tr>`;
    if (countId && $(countId)) $(countId).textContent = `${items.length} record${items.length === 1 ? '' : 's'}`;

    body.querySelectorAll('.defect-thumb').forEach(img => {
      img.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;padding:20px;box-sizing:border-box';
        const full = document.createElement('img');
        full.src = img.dataset.photo;
        full.style.cssText = 'max-width:100%;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)';
        overlay.appendChild(full);
        const closeOverlay = () => { overlay.remove(); document.removeEventListener('keydown', onEscKey); };
        const onEscKey = e => { if (e.key === 'Escape') closeOverlay(); };
        overlay.addEventListener('click', closeOverlay);
        document.addEventListener('keydown', onEscKey);
        document.body.appendChild(overlay);
      });
    });

    body.querySelectorAll('.bk-stage-select').forEach(sel => {
      sel.dataset.prev = sel.value;
      sel.addEventListener('change', async () => {
        const oppId = sel.dataset.opp, stage = sel.value, pl = sel.dataset.pipeline;
        sel.disabled = true;
        try {
          const r = await fetch(`/api/management/opportunities/${encodeURIComponent(oppId)}/stage`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body:    JSON.stringify({ pipeline: pl, stage }),
          });
          const d = await r.json();
          if (!d.success) throw new Error(d.message || 'Update failed.');
          sel.dataset.prev = stage;
          const badge = sel.closest('tr').querySelector('.badge');
          if (badge) badge.outerHTML = oppBadge(stage);
          toast(`Moved to ${stage}.`);
        } catch (e) {
          sel.value = sel.dataset.prev;
          toast(e.message || 'Could not update.', true);
        } finally {
          sel.disabled = false;
        }
      });
    });
    return { items, stages };
  }
  const PIPE_DONE = new Set(['Collected','Uncollected / Returned','Resolved','Closed','Completed','Departed','Cancelled']);
  const _pipeSnap = {}; // pipeline → { items, stages } - used for dashboard summary
  let _allBookings = [];
  let _allGuests   = [];
  let _annItems    = [];

  function _periodRange(period) {
    const sgToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    const addDays = (base, n) => {
      const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    if (period === 'today')    return { start: sgToday, end: sgToday };
    if (period === 'tomorrow') return { start: addDays(sgToday, 1), end: addDays(sgToday, 1) };
    if (period === 'week') {
      const dow = new Date(sgToday + 'T12:00:00Z').getUTCDay(); // 0=Sun
      const toMon = dow === 0 ? -6 : 1 - dow;
      return { start: addDays(sgToday, toMon), end: addDays(sgToday, toMon + 6) };
    }
    if (period === 'month') {
      const [y, m] = sgToday.split('-').map(Number);
      return {
        start: `${y}-${String(m).padStart(2,'0')}-01`,
        end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
      };
    }
    if (period === '30days') return { start: sgToday, end: addDays(sgToday, 29) };
    return { start: sgToday, end: sgToday };
  }

  const _periodLabel = {
    today:   'Today',      tomorrow: 'Tomorrow',
    week:    'This Week',  month:    'This Month',
    '30days':'Next 30 Days',
  };

  function _refreshDashKpis() {
    const { start, end } = _periodRange(_dashPeriod);
    const inRange = d => !!d && d >= start && d <= end;
    const label = _periodLabel[_dashPeriod] || 'Today';

    // Bookings: active (Confirmed / Deposit Pending) within the date window
    const ACTIVE_BK = new Set(['Confirmed', 'Deposit Pending']);
    const bkFiltered = _allBookings.filter(b => inRange(b.date || '') && ACTIVE_BK.has(b.stage));
    if ($('kpiBookings')) $('kpiBookings').textContent = bkFiltered.length;
    const bkSub = $('kpiBookings')?.closest('.kpi-card')?.querySelector('.kpi-sub');
    if (bkSub) bkSub.textContent = label;
    const titleLabel = label.endsWith('s') ? label + "'" : label + "'s";
    if ($('dashBookingsTitle')) $('dashBookingsTitle').textContent = titleLabel + ' Facility Bookings';
    const dash = $('dashBookingsBody');
    if (dash) {
      dash.innerHTML = bkFiltered.length
        ? bkFiltered.map(b => `<tr>
            <td>${esc(b.facility)}</td>
            <td>${esc(b.resident || 'Resident')}${b.unit ? ' (#' + esc(b.unit) + ')' : ''}</td>
            <td style="white-space:nowrap">${esc(b.slot)}</td>
            <td>${bkBadge(b.stage)}</td>
          </tr>`).join('')
        : `<tr class="empty-row"><td colspan="4">No bookings for ${label.toLowerCase()}.</td></tr>`;
    }

    // Guest Passes: filter by visit date
    const gFiltered = _allGuests.filter(g => inRange(g.visitDate || ''));
    if ($('kpiGuests')) $('kpiGuests').textContent = gFiltered.length;
    const gSub = $('kpiGuests')?.closest('.kpi-card')?.querySelector('.kpi-sub');
    const gActive = _allGuests.filter(g => !['Checked Out','Departed','Closed'].includes(g.stage)).length;
    if (gSub) gSub.textContent = `${gActive} active total`;

    // Defects: open items created in period
    if (_pipeSnap.defect) {
      const n = _pipeSnap.defect.items.filter(it => !PIPE_DONE.has(it.stage) && inRange((it.createdAt || '').slice(0,10))).length;
      if ($('kpiDefects')) $('kpiDefects').textContent = n;
    }

    // Parcels: pending items created in period
    if (_pipeSnap.parcel) {
      const n = _pipeSnap.parcel.items.filter(it => !PIPE_DONE.has(it.stage) && inRange((it.createdAt || '').slice(0,10))).length;
      if ($('kpiParcels')) $('kpiParcels').textContent = n;
    }

    // Feedback: open items created in period
    if (_pipeSnap.feedback) {
      const n = _pipeSnap.feedback.items.filter(it => !PIPE_DONE.has(it.stage) && inRange((it.createdAt || '').slice(0,10))).length;
      if ($('kpiFeedback')) $('kpiFeedback').textContent = n;
    }
  }

  function _renderPipelinesSummary() {
    const el = $('pipelinesBody'); if (!el) return;
    const pipelines = [
      { key: 'defect',   label: 'Defects' },
      { key: 'parcel',   label: 'Parcels' },
      { key: 'move',     label: 'Move Requests' },
      { key: 'feedback', label: 'Feedback' },
    ];
    const rows = pipelines.map(p => {
      const snap = _pipeSnap[p.key]; if (!snap) return '';
      const counts = {};
      snap.stages.forEach(s => counts[s] = 0);
      snap.items.forEach(it => { counts[it.stage] = (counts[it.stage] || 0) + 1; });
      const cells = snap.stages.map(s =>
        `<div class="pipe-stage-cell${PIPE_DONE.has(s) ? ' done' : ''}">
          <span class="pipe-stage-n">${counts[s] || 0}</span>
          <span class="pipe-stage-label">${esc(s)}</span>
        </div>`).join('');
      const open = snap.items.filter(it => !PIPE_DONE.has(it.stage)).length;
      return `<div class="pipe-row">
        <div class="pipe-row__name">${esc(p.label)}<span class="pipe-open-badge">${open} open</span></div>
        <div class="pipe-stages">${cells}</div>
      </div>`;
    }).filter(Boolean);
    el.innerHTML = rows.length
      ? rows.join('')
      : '<div class="panel-empty" style="padding:16px">No pipeline data yet.</div>';
  }

  async function loadDefects() {
    const result = await loadPipelinePanel('defect', 'defectsBody', 'defectCount');
    if (!result) return;
    _pipeSnap.defect = result;
    _refreshDashKpis();

    const dfStaSel = $('dfFilterStage');
    if (dfStaSel && dfStaSel.options.length === 1) {
      result.stages.forEach(s => dfStaSel.add(new Option(s, s)));
      const dfFilter = () => {
        const q   = ($('dfSearch')?.value   || '').toLowerCase();
        const urg = $('dfFilterUrgency')?.value || '';
        const sta = $('dfFilterStage')?.value   || '';
        let n = 0;
        $('defectsBody')?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const matchQ   = !q   || tr.textContent.toLowerCase().includes(q);
          const matchUrg = !urg || tr.classList.contains(`row-urgency-${urg}`);
          const matchSta = !sta || (tr.querySelector('.bk-stage-select')?.value === sta);
          const match = matchQ && matchUrg && matchSta;
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if ($('defectCount')) $('defectCount').textContent = `${n} record${n === 1 ? '' : 's'}`;
      };
      ['dfSearch', 'dfFilterUrgency', 'dfFilterStage'].forEach(id => {
        $(id)?.addEventListener('input', dfFilter);
        $(id)?.addEventListener('change', dfFilter);
      });
    }

    const sumEl = $('defectSummaryCells');
    if (sumEl) {
      const urgCount = { emergency: 0, urgent: 0, routine: 0 };
      result.items.filter(it => !PIPE_DONE.has(it.stage)).forEach(it => {
        const u = (it.urgency || 'routine').toLowerCase().match(/emergency|urgent|routine/)?.[0] || 'routine';
        urgCount[u]++;
      });
      sumEl.innerHTML = ['emergency','urgent','routine'].map(u =>
        `<div class="def-sum-cell ${u}">
          <div class="def-sum-n">${urgCount[u]}</div>
          <div class="def-sum-label">${u[0].toUpperCase() + u.slice(1)}</div>
        </div>`).join('');
    }
    _renderPipelinesSummary();
  }
  loadDefects().catch(e => console.error('[mgmt defects]', e));
  document.querySelectorAll('[data-view="defects"]').forEach(el =>
    el.addEventListener('click', () => loadDefects().catch(e => console.error('[mgmt defects]', e))));

  async function loadParcels() {
    const body = $('parcelsBody'), countEl = $('parcelCount');
    if (!body) return;
    const res  = await fetch('/api/management/opportunities?pipeline=parcel', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.success) {
      body.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(data.message || 'Could not load.')}</td></tr>`;
      return;
    }
    const items  = data.items  || [];
    const stages = data.stages || [];
    const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0;

    body.innerHTML = items.length
      ? items.map(it => {
          const ref  = it.reference || '';
          const authM = ref.match(/\[Auth:\s*([^\]]+)\]/);
          const auth  = authM ? authM[1].trim() : '';
          const code  = ref.split('')[0].trim() || ref;
          const overdue = daysSince(it.createdAt) >= 7 && !PIPE_DONE.has(it.stage);
          const dateCell = it.createdAt
            ? `${esc(bkDateLabel(it.createdAt.slice(0,10)))}${overdue ? ' <span class="badge badge-uncollected" title="7+ days uncollected">7d+</span>' : ''}`
            : '';
          const opts = stages.map(s => `<option value="${esc(s)}" ${s===it.stage?'selected':''}>${esc(s)}</option>`).join('');
          const stageSelect = it.oppId
            ? `<select class="bk-stage-select" data-opp="${esc(it.oppId)}" data-pipeline="parcel">${opts}</select>`
            : `<span class="bk-stage-none"> - </span>`;
          return `<tr>
            <td class="parcel-ref-cell"><span class="parcel-code">${esc(code)}</span></td>
            <td>${esc(it.contact)}</td>
            <td class="nowrap">${it.unit ? '#' + esc(it.unit) : ' - '}</td>
            <td class="parcel-auth">${auth ? esc(auth) : '<span class="cell-muted"> - </span>'}</td>
            <td>${oppBadge(it.stage)}</td>
            <td class="nowrap">${dateCell}</td>
            <td>${stageSelect}</td>
          </tr>`;
        }).join('')
      : `<tr class="empty-row"><td colspan="7">No parcel records.</td></tr>`;

    if (countEl) countEl.textContent = `${items.length} record${items.length===1?'':'s'}`;

    const pcStaSel = $('pcFilterStage');
    if (pcStaSel && pcStaSel.options.length === 1) {
      stages.forEach(s => pcStaSel.add(new Option(s, s)));
      const pcFilter = () => {
        const q   = ($('pcSearch')?.value || '').toLowerCase();
        const sta = $('pcFilterStage')?.value || '';
        let n = 0;
        body?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const matchQ   = !q   || tr.textContent.toLowerCase().includes(q);
          const matchSta = !sta || (tr.querySelector('.bk-stage-select')?.value === sta);
          const match = matchQ && matchSta;
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if (countEl) countEl.textContent = `${n} record${n === 1 ? '' : 's'}`;
      };
      ['pcSearch', 'pcFilterStage'].forEach(id => {
        $(id)?.addEventListener('input', pcFilter);
        $(id)?.addEventListener('change', pcFilter);
      });
    }

    body.querySelectorAll('.bk-stage-select').forEach(sel => {
      sel.dataset.prev = sel.value;
      sel.addEventListener('change', async () => {
        const oppId = sel.dataset.opp, stage = sel.value;
        sel.disabled = true;
        try {
          const r = await fetch(`/api/management/opportunities/${encodeURIComponent(oppId)}/stage`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ pipeline: 'parcel', stage }),
          });
          const d = await r.json();
          if (!d.success) throw new Error(d.message || 'Update failed.');
          sel.dataset.prev = stage;
          const badge = sel.closest('tr')?.querySelector('.badge');
          if (badge) badge.outerHTML = oppBadge(stage);
          toast(`Parcel moved to ${stage}.`);
        } catch (e) {
          sel.value = sel.dataset.prev;
          toast(e.message || 'Could not update.', true);
        } finally { sel.disabled = false; }
      });
    });

    const result = { items, stages };
    _pipeSnap.parcel = result;
    _refreshDashKpis();
    _renderPipelinesSummary();
  }
  loadParcels().catch(e => console.error('[mgmt parcels]', e));
  document.querySelectorAll('[data-view="parcels"]').forEach(el =>
    el.addEventListener('click', () => loadParcels().catch(e => console.error('[mgmt parcels]', e))));

  async function loadMoves() {
    const result = await loadPipelinePanel('move', 'moveBody', 'moveCount');
    if (!result) return;
    _pipeSnap.move = result;
    _renderPipelinesSummary();

    const mvStaSel = $('mvFilterStage');
    if (mvStaSel && mvStaSel.options.length === 1) {
      result.stages.forEach(s => mvStaSel.add(new Option(s, s)));
      const mvFilter = () => {
        const q   = ($('mvSearch')?.value || '').toLowerCase();
        const sta = $('mvFilterStage')?.value || '';
        let n = 0;
        $('moveBody')?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const matchQ   = !q   || tr.textContent.toLowerCase().includes(q);
          const matchSta = !sta || (tr.querySelector('.bk-stage-select')?.value === sta);
          const match = matchQ && matchSta;
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if ($('moveCount')) $('moveCount').textContent = `${n} record${n === 1 ? '' : 's'}`;
      };
      ['mvSearch', 'mvFilterStage'].forEach(id => {
        $(id)?.addEventListener('input', mvFilter);
        $(id)?.addEventListener('change', mvFilter);
      });
    }
  }
  loadMoves().catch(e => console.error('[mgmt moves]', e));
  document.querySelectorAll('[data-view="move"]').forEach(el =>
    el.addEventListener('click', () => loadMoves().catch(e => console.error('[mgmt moves]', e))));

  async function loadFeedback() {
    const result = await loadPipelinePanel('feedback', 'feedbackBody', 'feedbackCount');
    if (result) {
      _pipeSnap.feedback = result;
      _refreshDashKpis();
      _renderPipelinesSummary();
    }
    const { stages } = result || {};
    const fbStaSel = $('fbFilterStage');
    if (fbStaSel && fbStaSel.options.length === 1) {
      stages.forEach(s => fbStaSel.add(new Option(s, s)));
      const fbFilter = () => {
        const q   = ($('fbSearch')?.value || '').toLowerCase();
        const typ = $('fbFilterType')?.value || '';
        const sta = $('fbFilterStage')?.value || '';
        const PREFIX = { Complaint: 'CMP', Feedback: 'FBK', Suggestion: 'SUG' };
        let n = 0;
        $('feedbackBody')?.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const c = tr.querySelectorAll('td');
          const ref   = c[0]?.textContent.trim() || '';
          const stage = c[1]?.querySelector('.badge')?.textContent.trim() || '';
          const ftype = ref.startsWith('CMP') ? 'Complaint' : ref.startsWith('FBK') ? 'Feedback' : ref.startsWith('SUG') ? 'Suggestion' : '';
          const match = (!typ || ftype === typ) &&
                        (!sta || stage === sta) &&
                        (!q   || `${ref} ${c[2]?.textContent} ${c[3]?.textContent}`.toLowerCase().includes(q));
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if ($('feedbackCount')) $('feedbackCount').textContent = `${n} record${n === 1 ? '' : 's'}`;
      };
      ['fbSearch', 'fbFilterType', 'fbFilterStage'].forEach(id => {
        $(id)?.addEventListener('input', fbFilter);
        $(id)?.addEventListener('change', fbFilter);
      });
    }
  }
  loadFeedback().catch(e => console.error('[mgmt feedback]', e));
  document.querySelectorAll('[data-view="feedback"]').forEach(el =>
    el.addEventListener('click', () => loadFeedback().catch(e => console.error('[mgmt feedback]', e))));

  // Resident contacts (the account directory)
  async function loadContacts() {
    const body = $('contactsBody'); if (!body) return;
    const res  = await fetch('/api/management/residents', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.success) {
      body.innerHTML = `<tr class="empty-row"><td colspan="4">${esc(data.message || 'Could not load residents.')}</td></tr>`;
      throw new Error(data.message || 'Failed to load residents.');
    }
    const list = data.residents || [];
    body.innerHTML = list.length
      ? list.map(c => `<tr>
          <td>${esc(c.name)}</td>
          <td>${c.unit ? '#' + esc(c.unit) : ''}</td>
          <td>${esc(c.phone || '')}</td>
          <td><span class="tag tag-unit">${esc(c.type)}</span>${c.ghlLinked ? ' <span class="tag">GHL ✓</span>' : ''}</td>
        </tr>`).join('')
      : `<tr class="empty-row"><td colspan="4">No resident accounts.</td></tr>`;
    if ($('contactCount')) $('contactCount').textContent = `${list.length} resident${list.length === 1 ? '' : 's'}`;

    const ctSearch = $('ctSearch');
    if (ctSearch && !ctSearch.dataset.wired) {
      ctSearch.dataset.wired = '1';
      ctSearch.addEventListener('input', () => {
        const q = ctSearch.value.toLowerCase();
        let n = 0;
        body.querySelectorAll('tr:not(.empty-row)').forEach(tr => {
          const match = !q || tr.textContent.toLowerCase().includes(q);
          tr.style.display = match ? '' : 'none';
          if (match) n++;
        });
        if ($('contactCount')) $('contactCount').textContent = `${n} resident${n === 1 ? '' : 's'}`;
      });
    }
  }
  loadContacts().catch(e => console.error('[mgmt contacts]', e));
  document.querySelectorAll('[data-view="contacts"]').forEach(el =>
    el.addEventListener('click', () => loadContacts().catch(e => console.error('[mgmt contacts]', e))));

  // Announcements (published to resident Notices)
  function annDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }) : '';
  }
  function annCatClass(cat) {
    const c = (cat || '').toLowerCase();
    if (c.includes('maint'))                    return 'maint';
    if (c.includes('agm') || c.includes('egm')) return 'agm';
    if (c.includes('rule'))                     return 'rule';
    if (c.includes('event'))                    return 'event';
    if (c.includes('safety'))                   return 'safety';
    return '';
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

  async function loadAnnouncements() {
    const res  = await fetch('/api/management/announcements', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const items = (data.success && data.announcements) ? data.announcements : [];
    _annItems = items.map(a => Object.assign({}, a)); // shallow copy so unpin mutations don't affect cache

    const annList = $('annList');
    if (annList) {
      annList.innerHTML = items.length
        ? items.map(a => `
          <div class="ann-item${a.pinned ? ' ann-item--pinned' : ''}" data-ann-id="${esc(a.id)}">
            <div class="ann-meta">
              <span class="ann-category ${annCatClass(a.category)}">${esc(a.category)}</span>
              ${a.pinned ? '<button class="ann-unpin-btn" title="Unpin announcement"><span class="material-symbols-outlined ann-pin">push_pin</span></button>' : ''}
            </div>
            <div class="ann-title">${esc(a.title)}</div>
            ${a.eventAt ? `<div class="ann-event"><span class="material-symbols-outlined ann-event-icon">event</span>${esc(annWhen(a))}</div>` : ''}
            <div class="ann-body">${esc(a.body)}</div>
            ${(a.blocked_facilities && a.blocked_facilities.length) ? `<div class="ann-block-tag">🚫 Blocks: ${a.blocked_facilities.map(f => ({'pool':'Swimming Pool','tennis':'Tennis Court','squash':'Squash Court','basketball':'Basketball Court','gym':'Gymnasium','fitness':'Fitness Studio','bbq':'BBQ Pit','verandah':'Verandah','lift':'Service Lift'}[f]||f)).join(', ')}</div>` : ''}
            ${a.rsvp_enabled ? `<div class="ann-rsvp-summary" id="rsvp-summary-${esc(a.id)}"><span class="ann-rsvp-tag ann-rsvp-tag--none">Loading RSVP…</span></div>` : ''}
            <div class="ann-footer">
              <span>${esc(annDate(a.createdAt))}</span>
              <button class="ann-delete ann-del" data-id="${esc(a.id)}">Delete</button>
            </div>
          </div>`).join('')
        : '<div class="panel-empty">No announcements yet.</div>';
      annList.querySelectorAll('.ann-del').forEach(b => b.addEventListener('click', async () => {
        const confirmed = window.Swal
          ? (await window.Swal.fire({ title: 'Delete announcement?', text: 'This cannot be undone.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete', confirmButtonColor: '#c0392b', cancelButtonText: 'Cancel', reverseButtons: true })).isConfirmed
          : window.confirm('Delete this announcement? This cannot be undone.');
        if (!confirmed) return;
        b.disabled = true;
        try {
          const r = await fetch(`/api/management/announcements/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
          const d = await r.json();
          if (d.success) { toast('Announcement deleted.'); loadAnnouncements().catch(() => {}); }
          else { toast(d.message || 'Delete failed.', true); b.disabled = false; }
        } catch { toast('Connection error.', true); b.disabled = false; }
      }));

      // Unpin toggle
      let unpinModal = document.getElementById('annUnpinModal');
      if (!unpinModal) {
        unpinModal = document.createElement('div');
        unpinModal.id = 'annUnpinModal';
        unpinModal.innerHTML = `
          <div class="ann-unpin-backdrop"></div>
          <div class="ann-unpin-dialog">
            <p class="ann-unpin-msg">Unpin this announcement?</p>
            <p class="ann-unpin-sub">It will remain visible in the list but no longer pinned or highlighted.</p>
            <div class="ann-unpin-actions">
              <button class="btn-secondary ann-unpin-cancel">Cancel</button>
              <button class="btn-primary ann-unpin-confirm">Unpin</button>
            </div>
          </div>`;
        document.body.appendChild(unpinModal);
        unpinModal.querySelector('.ann-unpin-backdrop').addEventListener('click', () => unpinModal.classList.remove('open'));
        unpinModal.querySelector('.ann-unpin-cancel').addEventListener('click',   () => unpinModal.classList.remove('open'));
      }

      annList.querySelectorAll('.ann-unpin-btn').forEach(btn => btn.addEventListener('click', () => {
        const annEl = btn.closest('[data-ann-id]');
        if (!annEl) return;
        const id = annEl.dataset.annId;
        unpinModal.classList.add('open');
        // Replace any previous confirm handler to capture current id.
        const confirmBtn = unpinModal.querySelector('.ann-unpin-confirm');
        const fresh = confirmBtn.cloneNode(true);
        confirmBtn.replaceWith(fresh);
        fresh.addEventListener('click', async () => {
          unpinModal.classList.remove('open');
          fresh.disabled = true;
          try {
            const r = await fetch(`/api/management/announcements/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ pinned: false }),
            });
            const d = await r.json();
            if (!d.success) { toast(d.message || 'Unpin failed.', true); return; }
          } catch { toast('Connection error.', true); return; }
          const rec = _annItems.find(a => a.id === id);
          if (rec) rec.pinned = false;
          annEl.classList.remove('ann-item--pinned');
          const unpinBtn = annEl.querySelector('.ann-unpin-btn');
          if (unpinBtn) unpinBtn.remove();
          const pn = $('pinnedNotices');
          if (pn) {
            const pnItem = pn.querySelector(`[data-ann-id="${CSS.escape(id)}"]`);
            if (pnItem) {
              pnItem.remove();
              if (!pn.querySelector('[data-ann-id]')) {
                pn.innerHTML = '<div style="padding:1rem;font-size:0.75rem;color:var(--muted)">No pinned notices.</div>';
              }
            }
          }
          toast('Announcement unpinned.');
        });
      }));

      // Fetch RSVP summaries for rsvp-enabled events in parallel.
      items.filter(a => a.rsvp_enabled).forEach(async a => {
        try {
          const r = await fetch(`/api/management/rsvp/${encodeURIComponent(a.id)}`, { headers: { Authorization: `Bearer ${token}` } });
          const d = await r.json();
          const el = document.getElementById(`rsvp-summary-${a.id}`);
          if (!el || !d.success) return;
          if (d.total_responses === 0) {
            el.innerHTML = '<span class="ann-rsvp-tag ann-rsvp-tag--none">No RSVPs yet</span>';
            return;
          }
          el.innerHTML = `
            <span class="ann-rsvp-tag ann-rsvp-tag--yes">✓ ${d.attending_count} attending · ${d.attending_total} guest${d.attending_total !== 1 ? 's' : ''}</span>
            <span class="ann-rsvp-tag ann-rsvp-tag--no">✗ ${d.declined_count} declined</span>
            <button class="ann-rsvp-detail-btn">View list ▾</button>
            <div class="ann-rsvp-list hidden" id="rsvp-list-${esc(a.id)}"></div>`;
          el.querySelector('.ann-rsvp-detail-btn').addEventListener('click', function () {
            const listEl = document.getElementById(`rsvp-list-${a.id}`);
            if (!listEl) return;
            const open = !listEl.classList.contains('hidden');
            listEl.classList.toggle('hidden', open);
            this.textContent = open ? 'View list ▾' : 'Hide ▴';
            if (!open && !listEl.dataset.loaded) {
              listEl.dataset.loaded = '1';
              listEl.innerHTML = d.responses.length
                ? d.responses.map(rv => `
                  <div class="rsvp-row">
                    <span class="rsvp-unit">#${esc(rv.resident_unit || '')}</span>
                    <span>${esc(rv.resident_name || 'Resident')}</span>
                    <span class="${rv.response === 'yes' ? 'rsvp-resp-yes' : 'rsvp-resp-no'}">${rv.response === 'yes' ? `✓ ${rv.attendee_count} attending` : '✗ Declined'}</span>
                  </div>`).join('')
                : '<div style="padding:10px 12px;font-size:0.78rem;color:var(--muted)">No responses yet.</div>';
            }
          });
        } catch {
          const el = document.getElementById(`rsvp-summary-${a.id}`);
          if (el) el.innerHTML = '<span class="ann-rsvp-tag ann-rsvp-tag--none">RSVP unavailable</span>';
        }
      });
    }

    const pn = $('pinnedNotices');
    if (pn) {
      const pinned = items.filter(a => a.pinned);
      pn.innerHTML = pinned.length
        ? pinned.map(a => `
          <div data-ann-id="${esc(a.id)}" style="padding:0.7rem 1rem;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              <span class="material-symbols-outlined ann-pin">push_pin</span>
              <span style="font-size:0.8rem;color:var(--text);font-weight:600">${esc(a.title)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:0.72rem;color:var(--muted)">
              <span class="ann-category ${annCatClass(a.category)}">${esc(a.category)}</span>
              <span>${esc(annDate(a.createdAt))}</span>
            </div>
          </div>`).join('')
        : '<div style="padding:1rem;font-size:0.75rem;color:var(--muted)">No pinned notices.</div>';
    }

    const badge = $('badge-ann');
    if (badge) { if (items.length) { badge.style.display = ''; badge.textContent = items.length; } else { badge.style.display = 'none'; } }
  }
  loadAnnouncements().catch(e => console.error('[mgmt announcements]', e));
  document.querySelectorAll('[data-view="announcements"]').forEach(el =>
    el.addEventListener('click', () => loadAnnouncements().catch(e => console.error('[mgmt announcements]', e))));

  // Resident (host) typeahead search
  let _host = null; // { id, name, unit, email }
  let _searchTimer = null;
  const searchInput = $('guestResidentSearch');
  const dropdown    = $('residentDropdown');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _host = null;
      const q = searchInput.value.trim();
      clearTimeout(_searchTimer);
      if (q.length < 2) { if (dropdown) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); } return; }
      _searchTimer = setTimeout(async () => {
        try {
          const res  = await fetch('/api/management/contacts/search?q=' + encodeURIComponent(q), { headers: { Authorization: `Bearer ${token}` } });
          const data = await res.json();
          const list = data.contacts || [];
          if (!dropdown) return;
          dropdown.innerHTML = list.length
            ? list.map((c, i) => `<div class="search-option" data-i="${i}">${esc(c.name)} <span style="color:var(--muted)">· ${esc(c.unit || '')} · ${esc(c.email || '')}</span></div>`).join('')
            : '<div class="search-option" style="color:var(--muted)">No matches</div>';
          dropdown.classList.add('open');
          dropdown.querySelectorAll('.search-option[data-i]').forEach(el => el.addEventListener('click', () => {
            const c = list[+el.dataset.i];
            _host = c;
            searchInput.value = c.name;
            if ($('guestUnit')) $('guestUnit').value = c.unit || '';
            dropdown.classList.remove('open');
          }));
        } catch { if (dropdown) dropdown.classList.remove('open'); }
      }, 300);
    });
  }

  bind('guestRegisterBtn', async () => {
    const name        = $('guestVisitorName').value.trim();
    const date        = $('guestDate').value;
    const contactId   = ((_host && _host.id) || '').trim();
    const hostName    = _host ? _host.name : searchInput.value.trim();
    const hostUnit    = $('guestUnit').value.trim();
    const visitorType = $('guestVisitType') ? $('guestVisitType').value : '';
    const ic          = $('guestVisitorIc') ? $('guestVisitorIc').value.trim() : '';
    const vehicle     = $('guestVehicle')   ? $('guestVehicle').value.trim()   : '';
    const time        = $('guestTime')  ? $('guestTime').value  : '';
    const facility    = $('guestFacility') ? $('guestFacility').value : '';
    const mgmtNotes   = $('guestNotes') ? $('guestNotes').value.trim() : '';

    if (!contactId) { $('guestFormMsg').textContent = 'Please search and select the resident (host) first.'; return; }
    if (!name || !date) { $('guestFormMsg').textContent = 'Visitor name and visit date are required.'; return; }

    if (window.Swal) {
      const cells = [
        ['Resident (Host)', hostName + (hostUnit ? ' · ' + hostUnit : '')],
        ['Visitor Type',    visitorType || ''],
        ['Visitor Name',    name],
        ['IC / Passport',   ic      || ''],
        ['Vehicle',         vehicle || ''],
        ['Visit Date',      date],
        ['Time',            time    || ''],
        ['Facility',        facility || ''],
      ].map(([lbl, val]) =>
        `<div>
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:2px">${lbl}</div>
          <div style="color:#14110f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(val)}</div>
        </div>`).join('');
      const html = `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:#3f3832">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px${mgmtNotes ? ';margin-bottom:14px' : ''}">${cells}</div>
        ${mgmtNotes ? `<div style="background:#faf7f2;border-radius:6px;padding:10px 12px">
          <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:3px">Notes</div>
          <div style="color:#5a514a;font-size:0.82rem;line-height:1.5">${esc(mgmtNotes)}</div>
        </div>` : ''}
      </div>`;
      const { isConfirmed } = await window.Swal.fire({
        title:              'Review Guest Registration',
        html,
        showCancelButton:   true,
        confirmButtonText:  'Confirm &amp; Register',
        cancelButtonText:   '&#8592; Edit Details',
        confirmButtonColor: '#a5a3f5',
        cancelButtonColor:  '#9a9088',
        reverseButtons:     true,
        focusConfirm:       false,
      });
      if (!isConfirmed) return;
    }

    const btn = $('guestRegisterBtn');
    $('guestFormMsg').textContent = 'Registering…'; btn.disabled = true;
    try {
      const res = await fetch('/api/management/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          host_contact_id: contactId, host_name: hostName, host_unit: hostUnit, host_email: _host ? _host.email : '',
          visitor_type: visitorType, visitor_name: name, visitor_ic: ic, visitor_vehicle: vehicle,
          visit_date: date, visit_time: time, link_facility: facility, notes: mgmtNotes,
        }),
      });
      const data = await res.json();
      if (!data.success) { $('guestFormMsg').textContent = data.message || 'Registration failed.'; return; }
      $('guestFormMsg').textContent = '';
      if (window.Swal) {
        window.Swal.fire({
          icon:  'success',
          title: 'Guest Registered',
          html: `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:#3f3832">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
              <div>
                <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:2px">Visitor</div>
                <div style="color:#14110f">${esc(name)}</div>
              </div>
              <div>
                <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:2px">Visit Date</div>
                <div style="color:#14110f">${esc(date)}</div>
              </div>
              <div>
                <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:2px">Host</div>
                <div style="color:#14110f">${esc(hostName)}</div>
              </div>
              <div>
                <div style="font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:#a5a3f5;font-weight:700;margin-bottom:2px">Reference</div>
                <div style="color:#a5a3f5;font-family:'Courier New',monospace;font-size:0.8rem;font-weight:600">${esc(data.reference || '')}</div>
              </div>
            </div>
            <div style="background:#faf7f2;border-radius:6px;padding:10px 12px;font-size:0.82rem;color:#5a514a">QR pass sent to resident.</div>
          </div>`,
          confirmButtonText:  'Done',
          confirmButtonColor: '#a5a3f5',
        });
      }
      clearGuestForm();
    } catch {
      $('guestFormMsg').textContent = 'Connection error. Please try again.';
    } finally { btn.disabled = false; }
  });
  bind('guestClearBtn', clearGuestForm);
  function clearGuestForm() {
    _host = null;
    ['guestResidentSearch', 'guestUnit', 'guestVisitorName', 'guestVisitorIc', 'guestVehicle', 'guestTime', 'guestNotes']
      .forEach(id => { const el = $(id); if (el) el.value = ''; });
    if ($('guestVisitType')) $('guestVisitType').value = 'Social';
    if ($('guestFacility'))  $('guestFacility').value = '';
    const dd = $('residentDropdown'); if (dd) dd.classList.remove('open');
  }
  if ($('refreshIntervalInput')) $('refreshIntervalInput').value = localStorage.getItem('mgmtRefreshSecs') || 90;
  bind('saveSettingsBtn', () => {
    const secs = parseInt($('refreshIntervalInput').value, 10);
    if (secs >= 30) localStorage.setItem('mgmtRefreshSecs', secs);
    $('settingsMsg').textContent = 'Settings saved.'; setTimeout(() => { $('settingsMsg').textContent = ''; }, 2500);
  });
  bind('runProbeBtn', () => { $('probeResult').innerHTML = '<div style="padding:1rem;color:var(--orange);font-size:0.82rem">Data API not connected. Rebuild it and re-run the probe.</div>'; });
  bind('rawDataBtn', () => {
    const box = $('rawDataResult'); if (!box) return;
    if (box.style.display === 'none') { box.style.display = 'block'; $('rawDataPre').textContent = 'No data - API not connected.'; }
    else { box.style.display = 'none'; }
  });

  // Payments (deposits + history across all residents)
  function payDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }) : '';
  }
  function payMoney(n, cur) {
    return `${cur || 'SGD'} ${(Number(n) || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  let _mgmtPending = [];
  async function loadPaymentsPanel() {
    const pBody = $('mgmtPendingBody'), hBody = $('mgmtPayHistBody');
    try {
      const [bk, mv, hist] = await Promise.all([
        fetch('/api/management/bookings', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({})),
        fetch('/api/management/opportunities?pipeline=move', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({})),
        fetch('/api/management/payments', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({})),
      ]);
      // Pending deposits: facility bookings sit at "Deposit Pending" until paid; the
      // Move pipeline starts at "Requested", so a move owes a deposit at either stage.
      const DEPOSIT_FACS = ['bbq', 'pool', 'verandah'];
      const FACILITY_PENDING = ['Deposit Pending'];
      const MOVE_PENDING     = ['Requested', 'Deposit Pending'];
      // Deposit amounts (SGD). Move = 200 admin fee + 2000 refundable deposit = 2200.
      const DEPOSIT_AMOUNTS = { bbq: 200, pool: 200, verandah: 600, move: 2200 };
      _mgmtPending = [];
      (bk.items || []).forEach(b => { if (DEPOSIT_FACS.includes(b.facilityKey) && FACILITY_PENDING.includes(b.stage) && b.oppId) _mgmtPending.push({ pipeline: 'facility', oppId: b.oppId, facility_key: b.facilityKey, resident: b.resident, unit: b.unit, date: b.date, desc: b.facility, amount: DEPOSIT_AMOUNTS[b.facilityKey] || 0 }); });
      (mv.items || []).forEach(o => { if (MOVE_PENDING.includes(o.stage) && o.oppId) _mgmtPending.push({ pipeline: 'move', oppId: o.oppId, facility_key: '', resident: o.contact, unit: o.unit, date: '', desc: o.reference || 'Move-In / Move-Out', amount: DEPOSIT_AMOUNTS.move }); });
      if (pBody) {
        pBody.innerHTML = _mgmtPending.length
          ? _mgmtPending.map((d, i) => `<tr>
              <td>${esc(d.resident || '')}</td><td>${d.unit ? '#' + esc(d.unit) : ''}</td>
              <td>${esc(d.desc)}</td><td>${d.date ? esc(payDate(d.date)) : ''}</td>
              <td>${d.amount ? esc(payMoney(d.amount, 'SGD')) : ''}</td>
              <td><span class="tag" style="background:rgba(49,46,129,.15);color:var(--gold,#312e81)">Deposit Pending</span></td>
              <td><button class="btn-primary" style="padding:5px 12px;font-size:0.72rem" data-paid="${i}">Mark as Paid</button></td>
            </tr>`).join('')
          : '<tr class="empty-row"><td colspan="7">No pending deposits.</td></tr>';
        pBody.querySelectorAll('[data-paid]').forEach(btn => btn.addEventListener('click', () => markPaid(_mgmtPending[+btn.dataset.paid], btn)));
      }
      if ($('payPendingCount')) $('payPendingCount').textContent = `${_mgmtPending.length} pending`;
      const badge = $('badge-payments');
      if (badge) { if (_mgmtPending.length) { badge.style.display = ''; badge.textContent = _mgmtPending.length; } else { badge.style.display = 'none'; } }
      // History = recorded payments (Payment collection) + Deposit Refunded moves.
      // A refund is a GHL move-pipeline stage change, not a Payment record, so pull
      // the amount from the matching paid deposit when one was recorded.
      const payments = (hist.success && hist.payments) ? hist.payments : [];
      const tagStyle = (s) => s === 'paid'     ? 'rgba(39,174,96,.15);color:#27ae60'
                            : s === 'refunded' ? 'rgba(90,81,74,.15);color:var(--text-2,#5a514a)'
                            :                    'rgba(49,46,129,.15);color:var(--gold,#312e81)';
      const histRows = payments.map(p => ({
        date: p.paid_at || p.createdAt, unit: p.resident_unit,
        desc: p.description, category: p.category, amount: p.amount, currency: p.currency, status: p.status,
      }));
      // Only the SGD 2000 refundable deposit is returned (the SGD 200 admin fee is not).
      const MOVE_REFUNDABLE_DEPOSIT = 2000;
      (mv.items || []).filter(o => o.stage === 'Deposit Refunded' && o.oppId).forEach(o => {
        histRows.push({
          date: o.createdAt || '', unit: o.unit,
          desc: o.reference || 'Move-In / Move-Out', category: 'Refundable Deposit',
          amount: MOVE_REFUNDABLE_DEPOSIT, currency: 'SGD', status: 'refunded',
        });
      });
      histRows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      if (hBody) {
        hBody.innerHTML = histRows.length
          ? histRows.map(p => `<tr>
              <td>${p.date ? esc(payDate(p.date)) : ''}</td><td>${p.unit ? '#' + esc(p.unit) : ''}</td>
              <td>${esc(p.desc)}</td><td>${esc(p.category)}</td><td>${p.amount != null ? esc(payMoney(p.amount, p.currency)) : ''}</td>
              <td><span class="tag" style="background:${tagStyle(p.status)}">${esc(p.status)}</span></td>
            </tr>`).join('')
          : '<tr class="empty-row"><td colspan="6">No payment records yet.</td></tr>';
      }
      if ($('payHistCount')) $('payHistCount').textContent = `${histRows.length} record${histRows.length === 1 ? '' : 's'}`;
    } catch (e) {
      if (pBody) pBody.innerHTML = '<tr class="empty-row"><td colspan="7">Could not load.</td></tr>';
    }
  }
  async function markPaid(d, btn) {
    if (!d) return;
    btn.disabled = true; btn.textContent = 'Confirming…';
    try {
      const res = await fetch('/api/payments/pay-deposit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pipeline: d.pipeline, opportunity_id: d.oppId, facility_key: d.facility_key, description: d.desc, unit: d.unit, name: d.resident }),
      });
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not confirm.', true); btn.disabled = false; btn.textContent = 'Mark as Paid'; return; }
      toast('Marked paid - booking confirmed.');
      loadPaymentsPanel();
    } catch { toast('Connection error.', true); btn.disabled = false; btn.textContent = 'Mark as Paid'; }
  }
  loadPaymentsPanel().catch(e => console.error('[mgmt payments]', e));
  document.querySelectorAll('[data-view="payments"]').forEach(el =>
    el.addEventListener('click', () => loadPaymentsPanel().catch(e => console.error('[mgmt payments]', e))));

  // Live payments
  // Pending deposits + history refresh without a manual reload: poll fast while the
  // Payments view is open, plus the same global cadence as bookings. A tick is skipped
  // while a "Mark as Paid" action is in flight so it isn't disrupted, and overlapping
  // polls are coalesced.
  const _paymentsBusy = () => !!$('mgmtPendingBody')?.querySelector('button[disabled]');
  let _payPolling = false;
  async function _pollPayments() {
    if (_payPolling || _paymentsBusy()) return;
    _payPolling = true;
    try { await loadPaymentsPanel(); } catch {} finally { _payPolling = false; }
  }
  setInterval(() => { if ($('view-payments')?.classList.contains('active')) _pollPayments(); }, 15000);
  setInterval(_pollPayments, _bkSecs * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('view-payments')?.classList.contains('active')) _pollPayments();
  });

  // Live panels: guests / defects / parcels / move / feedback / announcements
  // While a view is open, silently re-run its loader so resident submissions and stage
  // changes appear without a manual reload. Skips a tick while the manager is mid-
  // interaction (a focused field, or an in-flight stage update) and re-applies any
  // active search/filter afterwards so the refresh doesn't reset the view.
  function _mgmtViewBusy(viewId) {
    const v = $(viewId); if (!v) return false;
    const a = document.activeElement;
    if (a && v.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return true;
    return !!v.querySelector('select[disabled]');   // a stage update in flight
  }
  const _mgmtPollLock = {};
  function _livePanelMgmt(viewId, loader) {
    setInterval(async () => {
      const v = $(viewId);
      if (!v || !v.classList.contains('active') || _mgmtViewBusy(viewId) || _mgmtPollLock[viewId]) return;
      _mgmtPollLock[viewId] = true;
      try {
        await loader();
        // Re-apply the manager's active search/filter (controls are id…Search / …Filter…).
        v.querySelectorAll('[id$="Search"], [id*="Filter"]').forEach(inp => { if (inp.value) inp.dispatchEvent(new Event('input')); });
      } catch {} finally { _mgmtPollLock[viewId] = false; }
    }, 15000);
  }
  _livePanelMgmt('view-guests',        loadGuests);
  _livePanelMgmt('view-defects',       loadDefects);
  _livePanelMgmt('view-parcels',       loadParcels);
  _livePanelMgmt('view-move',          loadMoves);
  _livePanelMgmt('view-feedback',      loadFeedback);
  _livePanelMgmt('view-announcements', loadAnnouncements);

  // Resident messages - wired to the shared inbox design (inbox.css)
  let _mgmtConvoId = null, _mgmtConvoName = '', _mgmtConvoResolved = false;
  let _mgmtConvos = [], _mgmtFilter = 'all', _mgmtSearch = '';
  function mgmtClock(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }) : '';
  }
  function mgmtDayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso), today = new Date(), yest = new Date(); yest.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Today';
    if (same(d, yest))  return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
  }
  function mgmtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    return d.toDateString() === now.toDateString() ? mgmtClock(iso)
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Singapore' });
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  }
  async function loadConversations() {
    const listEl = $('mgmtInboxList');
    try {
      const res  = await fetch('/api/management/messages', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      _mgmtConvos = (data.success && data.conversations) ? data.conversations : [];
      renderConversations();
      const badge = $('badge-messages');
      if (badge) { if (data.total_unread) { badge.style.display = ''; badge.textContent = data.total_unread > 9 ? '9+' : data.total_unread; } else { badge.style.display = 'none'; } }
    } catch (e) {
      if (listEl) listEl.innerHTML = '<div class="inbox__loading" style="padding:1.5rem;color:var(--muted,#9a9088)">Could not load conversations.</div>';
    }
  }
  // Render the conversation list filtered by the active tab. Resolved threads live
  // under the "Resolved" tab and drop out of "All"/"Unread" - the active queue.
  function renderConversations() {
    const listEl = $('mgmtInboxList');
    if (!listEl) return;
    const q = _mgmtSearch.toLowerCase();
    const filtered = _mgmtConvos.filter(c => {
      const byTab = _mgmtFilter === 'resolved' ? c.resolved
        : _mgmtFilter === 'unread' ? (c.unread_management && !c.resolved)
        : !c.resolved;
      if (!byTab) return false;
      if (!q) return true;
      return (c.resident_name || '').toLowerCase().includes(q)
        || (c.resident_unit || '').toLowerCase().includes(q)
        || (c.last_message_preview || '').toLowerCase().includes(q);
    });
    if (!filtered.length) {
      const msg = _mgmtFilter === 'resolved' ? 'No resolved conversations yet.'
        : _mgmtFilter === 'unread' ? 'No unread conversations.'
        : 'No active conversations.';
      listEl.innerHTML = `<div class="inbox__loading" style="padding:1.5rem;text-align:center;color:var(--muted,#9a9088);font-size:0.82rem">${msg}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(c => `
      <div class="inbox__item${c.unread_management ? ' inbox__item--unread' : ''}${c.id === _mgmtConvoId ? ' active' : ''}" data-convo-id="${esc(c.id)}" tabindex="0" role="button">
        <div class="inbox__item-avatar">${esc(initials(c.resident_name))}</div>
        <div class="inbox__item-body">
          <div class="inbox__item-row">
            <span class="inbox__item-name">${esc(c.resident_name)}${c.resident_unit ? ` <span class="inbox__unit-tag">#${esc(c.resident_unit)}</span>` : ''}</span>
            <span class="inbox__item-time">${esc(mgmtShort(c.last_message_at))}</span>
          </div>
          <div class="inbox__item-row">
            <span class="inbox__item-preview">${c.last_sender === 'management' ? 'You: ' : ''}${esc(c.last_message_preview || 'No messages yet')}</span>
            ${c.unread_management ? `<span class="inbox__item-badge">${c.unread_management > 9 ? '9+' : c.unread_management}</span>`
              : c.resolved ? '<span class="inbox__item-status resolved">Resolved</span>' : ''}
          </div>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('.inbox__item').forEach(el =>
      el.addEventListener('click', () => openConversation(el.dataset.convoId)));
  }
  async function openConversation(id, silent) {
    if (!id) return;
    const switching = id !== _mgmtConvoId;
    _mgmtConvoId = id;
    if (!silent) { const ix = $('mgmtInbox'); if (ix) ix.classList.add('inbox--thread-open'); }
    document.querySelectorAll('#mgmtInboxList .inbox__item').forEach(el => el.classList.toggle('active', el.dataset.convoId === id));
    const msgsEl = $('mgmtInboxMessages');
    if (msgsEl && switching) msgsEl.dataset.sig = '';
    if (msgsEl && !silent) msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;text-align:center;padding:2rem;color:var(--muted,#9a9088)">Loading…</div>';
    try {
      const res  = await fetch(`/api/management/messages/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) { if (msgsEl) msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;padding:2rem;color:var(--muted,#9a9088)">Could not load this conversation.</div>'; return; }
      const c = data.conversation;
      _mgmtConvoName = c.resident_name || 'Resident';
      if ($('mgmtThreadAvatar')) $('mgmtThreadAvatar').textContent = initials(c.resident_name);
      if ($('mgmtThreadName'))   $('mgmtThreadName').textContent   = c.resident_name || 'Resident';
      const unitTag = $('mgmtThreadUnit');
      if (unitTag) { if (c.resident_unit) { unitTag.style.display = ''; unitTag.textContent = `#${c.resident_unit}`; } else unitTag.style.display = 'none'; }
      if ($('mgmtThreadSub'))    $('mgmtThreadSub').textContent    = c.resident_email || '';
      const msgs = data.messages || [];
      if (msgsEl) {
        if (!msgs.length) {
          msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;text-align:center;padding:2rem;color:var(--muted,#9a9088)">No messages yet.</div>';
        } else {
          const unreadRes = c.unread_resident || 0;
          let html = '', lastDay = '';
          msgs.forEach((m, i) => {
            const day = mgmtDayLabel(m.createdAt);
            if (day !== lastDay) { html += `<div class="inbox__date-sep"><span>${esc(day)}</span></div>`; lastDay = day; }
            const out = m.sender === 'management';
            let statusIcon = '';
            if (out) {
              const hasReplyAfter = msgs.slice(i + 1).some(m2 => m2.sender !== 'management');
              const isRead = hasReplyAfter || unreadRes === 0;
              statusIcon = isRead
                ? '<span class="msg-status msg-status--read material-symbols-outlined" title="Read">done_all</span>'
                : '<span class="msg-status msg-status--sent material-symbols-outlined" title="Sent">done</span>';
            }
            html += `<div class="inbox__msg inbox__msg--${out ? 'out' : 'in'}">
              <div class="inbox__msg-bubble">${esc(m.body)}</div>
              <div class="inbox__msg-time">${esc(mgmtClock(m.createdAt))}${statusIcon}</div>
            </div>`;
          });
          // Avoid clobbering the view on silent polls when nothing changed.
          if (msgsEl.dataset.sig !== String(msgs.length) || switching) {
            msgsEl.innerHTML = html;
            if (switching || !silent || msgsEl.dataset.sig !== String(msgs.length)) msgsEl.scrollTop = msgsEl.scrollHeight;
          }
          msgsEl.dataset.sig = String(msgs.length);
        }
      }
      const ta = $('mgmtCompose'), btn = $('mgmtSendBtn');
      if (ta)  { ta.disabled = false; ta.placeholder = `Reply to ${_mgmtConvoName}…`; }
      if (btn) btn.disabled = false;
      _mgmtConvoResolved = !!c.resolved;
      const rBtn = $('mgmtResolveBtn'), rLabel = $('mgmtResolveLabel');
      if (rBtn) {
        rBtn.style.display = '';
        rBtn.classList.toggle('resolved', _mgmtConvoResolved);
        if (rLabel) rLabel.textContent = _mgmtConvoResolved ? 'Resolved · Reopen' : 'Mark Resolved';
      }
      if (!silent) loadConversations(); // refresh unread state + badge after marking read
    } catch {
      if (msgsEl && !silent) msgsEl.innerHTML = '<div class="inbox__empty-state" style="margin:auto;padding:2rem;color:var(--muted,#9a9088)">Connection error.</div>';
    }
  }
  async function sendReply() {
    const ta = $('mgmtCompose'), btn = $('mgmtSendBtn');
    if (!ta || !_mgmtConvoId) return;
    const body = ta.value.trim();
    if (!body) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/management/messages/${encodeURIComponent(_mgmtConvoId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Could not send reply.', true); return; }
      ta.value = ''; ta.style.height = 'auto';
      openConversation(_mgmtConvoId);
    } catch { toast('Connection error.', true); }
    finally { if (btn) btn.disabled = false; }
  }
  if ($('mgmtSendBtn')) $('mgmtSendBtn').addEventListener('click', sendReply);
  if ($('mgmtCompose')) {
    $('mgmtCompose').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } });
  }
  if ($('mgmtResolveBtn')) {
    $('mgmtResolveBtn').addEventListener('click', async () => {
      if (!_mgmtConvoId) return;
      const target = !_mgmtConvoResolved;
      const btn = $('mgmtResolveBtn'); btn.disabled = true;
      try {
        const res = await fetch(`/api/management/messages/${encodeURIComponent(_mgmtConvoId)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ resolved: target }),
        });
        const data = await res.json();
        if (!data.success) { toast(data.message || 'Could not update status.', true); return; }
        _mgmtConvoResolved = target;
        btn.classList.toggle('resolved', target);
        const rLabel = $('mgmtResolveLabel'); if (rLabel) rLabel.textContent = target ? 'Resolved · Reopen' : 'Mark Resolved';
        toast(target ? 'Conversation marked resolved.' : 'Conversation reopened.');
        loadConversations();
      } catch { toast('Connection error.', true); }
      finally { btn.disabled = false; }
    });
  }

  // New-message composer modal (open/close handled inline)
  async function loadMessageResidents() {
    const sel = $('mgmtConvoResident');
    if (!sel || sel.dataset.loaded === '1') return;
    try {
      const res  = await fetch('/api/management/messages-residents', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const list = (data.success && data.residents) ? data.residents : [];
      sel.innerHTML = '<option value="">Select a resident</option>'
        + list.map((r, i) => `<option value="${i}">${esc(r.name)}${r.unit ? ` · #${esc(r.unit)}` : ''}</option>`).join('');
      sel._residents = list;
      sel.dataset.loaded = '1';
    } catch { sel.innerHTML = '<option value="">Could not load residents</option>'; }
  }
  if ($('mgmtInboxNewBtn')) $('mgmtInboxNewBtn').addEventListener('click', loadMessageResidents);
  if ($('mgmtInboxBack')) {
    $('mgmtInboxBack').addEventListener('click', () => {
      const ix = $('mgmtInbox'); if (ix) ix.classList.remove('inbox--thread-open');
    });
  }
  if ($('mgmtConvoSend')) {
    $('mgmtConvoSend').addEventListener('click', async () => {
      const sel  = $('mgmtConvoResident');
      const subj = $('mgmtConvoSubject') ? $('mgmtConvoSubject').value.trim() : '';
      const body = $('mgmtConvoMsg') ? $('mgmtConvoMsg').value.trim() : '';
      const errEl = $('mgmtConvoErr');
      const idx  = sel ? sel.value : '';
      const r = (sel && sel._residents && idx !== '') ? sel._residents[parseInt(idx, 10)] : null;
      if (errEl) errEl.textContent = '';
      if (!r)    { if (errEl) errEl.textContent = 'Please choose a resident.'; return; }
      if (!body) { if (errEl) errEl.textContent = 'Please type a message.'; return; }
      const full = subj ? `${subj}\n\n${body}` : body;
      const btn = $('mgmtConvoSend'); btn.disabled = true;
      try {
        const res = await fetch('/api/management/messages/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ contact_id: r.contact_id, resident_email: r.email, resident_name: r.name, resident_unit: r.unit, body: full }),
        });
        const data = await res.json();
        if (!data.success) { if (errEl) errEl.textContent = data.message || 'Could not send.'; return; }
        const modal = $('mgmtInboxNewModal'); if (modal) modal.style.display = 'none';
        if ($('mgmtConvoSubject')) $('mgmtConvoSubject').value = '';
        if ($('mgmtConvoMsg'))     $('mgmtConvoMsg').value = '';
        if (sel) sel.value = '';
        toast('Message sent.');
        await loadConversations();
        if (data.conversation_id) openConversation(data.conversation_id);
      } catch { if (errEl) errEl.textContent = 'Connection error.'; }
      finally { btn.disabled = false; }
    });
  }

  // Inbox search.
  document.querySelector('.inbox__search')?.addEventListener('input', e => {
    _mgmtSearch = e.target.value.trim();
    renderConversations();
  });

  // Filter tabs: All (active) · Unread · Resolved.
  if ($('mgmtInboxFilters')) {
    $('mgmtInboxFilters').querySelectorAll('.inbox__filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $('mgmtInboxFilters').querySelectorAll('.inbox__filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _mgmtFilter = tab.dataset.filter || 'all';
        renderConversations();
      });
    });
  }

  loadConversations().catch(e => console.error('[mgmt messages]', e));
  loadMessageResidents().catch(() => {});
  document.querySelectorAll('[data-view="messages"]').forEach(el =>
    el.addEventListener('click', () => loadConversations().catch(e => console.error('[mgmt messages]', e))));
  setInterval(() => loadConversations().catch(() => {}), 30000);
  // Live inbox: while the Messages view is open, refresh the list + open thread.
  setInterval(() => {
    const v = $('view-messages');
    if (!v || !v.classList.contains('active')) return;
    loadConversations().catch(() => {});
    if (_mgmtConvoId) openConversation(_mgmtConvoId, true).catch(() => {});
  }, 7000);

  // Resources
  const RES_CAT_ICONS = {
    'By-Laws':           'gavel',
    'Fire Safety':       'local_fire_department',
    'Meeting Minutes':   'event_note',
    'Strata Title Plan': 'map',
    'Other':             'description',
  };

  function _resFmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function _resFmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
  }

  function _resEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const RES_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // "NEW" badge for docs published in the last 7 days
  let _mgmtAllDocs = [];
  const _resSelected = new Set();
  let _selectMode = false;

  function _updateBulkBar() {
    const bar = $('resBulkBar');
    if (bar) bar.hidden = !_selectMode;
    const countEl = $('resBulkCount');
    if (countEl) countEl.textContent = `${_resSelected.size} selected`;
    const delBtn = $('resBulkDeleteBtn');
    if (delBtn) delBtn.disabled = _resSelected.size === 0;
    const toggleBtn = $('resSelectToggleBtn');
    if (toggleBtn) toggleBtn.classList.toggle('res-select-toggle-btn--active', _selectMode);
  }

  // Select mode is off by default - checkboxes and the bulk bar only appear
  // once the user deliberately opts in via the "Select" button, instead of
  // cluttering every row unconditionally.
  function _setSelectMode(on) {
    _selectMode = on;
    if (!on) _resSelected.clear();
    _updateBulkBar();
    _renderMgmtResources($('resSearchInput')?.value || '');
  }

  const resSelectToggleBtn = $('resSelectToggleBtn');
  if (resSelectToggleBtn) {
    resSelectToggleBtn.addEventListener('click', () => _setSelectMode(!_selectMode));
  }

  const RES_VIS_LABELS = { residents: 'All Residents', owners: 'Owners Only', tenants: 'Tenants Only' };

  function _renderResList(containerId, docs) {
    const el = $(containerId);
    if (!el) return;
    if (!docs.length) {
      el.innerHTML = '<div class="res-empty">No documents yet.</div>';
      return;
    }
    el.innerHTML = docs.map(d => {
      const isNew = d.createdAt && (Date.now() - new Date(d.createdAt).getTime()) < RES_NEW_WINDOW_MS;
      const visLabel = RES_VIS_LABELS[d.visibility];
      return `
      <div class="res-item" data-res-id="${_resEsc(d.id)}">
        ${_selectMode ? `<input type="checkbox" class="res-select-cb" data-res-id="${_resEsc(d.id)}" ${_resSelected.has(d.id) ? 'checked' : ''} aria-label="Select ${_resEsc(d.title)}" />` : ''}
        <span class="material-symbols-outlined res-item-icon">${_resEsc(RES_CAT_ICONS[d.category] || 'description')}</span>
        <div class="res-item-info">
          <span class="res-item-title">${_resEsc(d.title)}${isNew ? '<span class="res-new-badge">New</span>' : ''}</span>
          <span class="res-item-meta">${_resEsc(d.category)}${visLabel ? ' · ' + _resEsc(visLabel) : ''} · ${_resEsc(d.file_name)}${d.file_size ? ' · ' + _resFmtSize(d.file_size) : ''}${d.createdAt ? ' · Uploaded ' + _resFmtDate(d.createdAt) : ''}</span>
        </div>
        <div class="res-item-actions">
          <button class="res-view-btn" data-res-id="${_resEsc(d.id)}" data-title="${_resEsc(d.title)}" data-file-name="${_resEsc(d.file_name)}" data-file-type="${_resEsc(d.file_type)}" title="View">
            <span class="material-symbols-outlined">visibility</span>
          </button>
          <button class="res-dl-btn" data-res-id="${_resEsc(d.id)}" data-file-name="${_resEsc(d.file_name)}" data-file-type="${_resEsc(d.file_type)}" title="Download">
            <span class="material-symbols-outlined">download</span>
          </button>
          <button class="res-del-btn" data-res-id="${_resEsc(d.id)}" data-title="${_resEsc(d.title)}" title="Delete">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>
    `;
    }).join('');
    el.querySelectorAll('.res-select-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _resSelected.add(cb.dataset.resId);
        else _resSelected.delete(cb.dataset.resId);
        _updateBulkBar();
      });
    });
    el.querySelectorAll('.res-view-btn').forEach(btn => {
      btn.addEventListener('click', () => _resMgmtView(btn.dataset.resId, btn.dataset.title, btn.dataset.fileName, btn.dataset.fileType, btn));
    });
    el.querySelectorAll('.res-dl-btn').forEach(btn => {
      btn.addEventListener('click', () => _resMgmtDownload(btn.dataset.resId, btn.dataset.fileName, btn.dataset.fileType, btn));
    });
    el.querySelectorAll('.res-del-btn').forEach(btn => {
      btn.addEventListener('click', () => _resDelete(btn.dataset.resId, btn.dataset.title));
    });
  }

  function _renderMgmtResources(searchTerm) {
    const q = (searchTerm || '').trim().toLowerCase();
    const docs = q
      ? _mgmtAllDocs.filter(d => d.title.toLowerCase().includes(q) || (d.category || '').toLowerCase().includes(q))
      : _mgmtAllDocs;
    const shared   = docs.filter(d => d.visibility !== 'management');
    const private_ = docs.filter(d => d.visibility === 'management');
    _renderResList('resMgmtResidentList', shared);
    _renderResList('resMgmtPrivateList', private_);
  }

  (() => {
    const input = $('resSearchInput');
    if (input) input.addEventListener('input', () => _renderMgmtResources(input.value));
  })();

  async function loadMgmtResources(_isRetry) {
    if (!_isRetry) {
      [$('resMgmtResidentList'), $('resMgmtPrivateList')].forEach(el => {
        if (el) el.innerHTML = '<div class="loading">Loading…</div>';
      });
    }
    try {
      const res  = await fetch('/api/management/resources', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Failed to load resources.');
      _mgmtAllDocs = data.resources || [];
      _resSelected.clear();
      _updateBulkBar();
      _renderMgmtResources($('resSearchInput')?.value || '');
    } catch (err) {
      // The very first load can race the zero-click preview's background
      // login (see client-backend.js) — silently retry once before showing
      // an error, so the preview self-heals instead of looking broken.
      if (!_isRetry) {
        setTimeout(() => loadMgmtResources(true), 1500);
        return;
      }
      toast(err.message, true);
      [$('resMgmtResidentList'), $('resMgmtPrivateList')].forEach(el => {
        if (el) el.innerHTML = `<div class="res-empty">${_resEsc(err.message)}</div>`;
      });
    }
  }

  async function _resMgmtDownload(id, fileName, fileType, btn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span>';
    try {
      const res  = await fetch(`/api/management/resources/${encodeURIComponent(id)}/download`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success || !data.file_data) throw new Error(data.message || 'Download failed.');
      _resTriggerDownload(data.file_data, data.file_name || fileName, data.file_type || fileType);
    } catch (err) {
      toast('Download failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  // Opens the document in an in-page modal (not a new tab) using an iframe -
  // the browser's native PDF/image viewer renders inside it either way.
  async function _resMgmtView(id, title, fileName, fileType, btn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span>';
    try {
      const res  = await fetch(`/api/management/resources/${encodeURIComponent(id)}/download`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success || !data.file_data) throw new Error(data.message || 'Could not open document.');
      const blobUrl = _resDataUrlToBlobUrl(data.file_data, data.file_type || fileType);
      _openResPreviewModal(blobUrl, title || fileName);
    } catch (err) {
      toast('Could not open document: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  let _resPreviewBlobUrl = null;
  function _openResPreviewModal(blobUrl, title) {
    const modal = $('resPreviewModal');
    const frame = $('resPreviewFrame');
    if (!modal || !frame) return;
    if (_resPreviewBlobUrl) URL.revokeObjectURL(_resPreviewBlobUrl);
    _resPreviewBlobUrl = blobUrl;
    frame.src = blobUrl;
    const titleEl = $('resPreviewTitle');
    if (titleEl) titleEl.textContent = title || 'Document';
    modal.classList.add('open');
  }
  function _closeResPreviewModal() {
    const modal = $('resPreviewModal');
    const frame = $('resPreviewFrame');
    if (modal) modal.classList.remove('open');
    if (frame) frame.src = 'about:blank';
    if (_resPreviewBlobUrl) { URL.revokeObjectURL(_resPreviewBlobUrl); _resPreviewBlobUrl = null; }
  }
  (() => {
    const modal = $('resPreviewModal');
    if (!modal) return;
    bind('resPreviewClose', _closeResPreviewModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) _closeResPreviewModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) _closeResPreviewModal(); });
  })();

  function _resDataUrlToBlobUrl(dataUrl, fallbackMime) {
    const comma = dataUrl.indexOf(',');
    const isDataUrl = dataUrl.startsWith('data:');
    const mime = isDataUrl ? dataUrl.slice(5, comma).split(';')[0] : (fallbackMime || 'application/octet-stream');
    const base64 = isDataUrl ? dataUrl.slice(comma + 1) : dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  function _resTriggerDownload(base64DataUrl, fileName, mimeType) {
    const url = base64DataUrl.startsWith('data:')
      ? base64DataUrl
      : `data:${mimeType || 'application/octet-stream'};base64,${base64DataUrl}`;
    const a = document.createElement('a');
    a.href     = url;
    a.download = fileName || 'document';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function _resDelete(id, title) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      const res  = await fetch(`/api/management/resources/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Delete failed.');
      toast('Document deleted.');
      loadMgmtResources();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Bulk delete — reuses the existing single-delete endpoint for each selected
  // document (no dedicated bulk endpoint exists).
  const resBulkDeleteBtn = $('resBulkDeleteBtn');
  if (resBulkDeleteBtn) {
    resBulkDeleteBtn.addEventListener('click', async () => {
      const ids = [..._resSelected];
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} document${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
      resBulkDeleteBtn.disabled = true;
      try {
        const results = await Promise.allSettled(ids.map(id => fetch(`/api/management/resources/${encodeURIComponent(id)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        })));
        const failed = results.filter(r => r.status === 'rejected').length;
        toast(failed ? `Deleted ${ids.length - failed} of ${ids.length}; ${failed} failed.` : `${ids.length} document${ids.length > 1 ? 's' : ''} deleted.`, !!failed);
        _setSelectMode(false);
        loadMgmtResources();
      } catch (err) {
        toast(err.message, true);
      } finally {
        resBulkDeleteBtn.disabled = false;
      }
    });
  }
  const resBulkCancelBtn = $('resBulkCancelBtn');
  if (resBulkCancelBtn) {
    resBulkCancelBtn.addEventListener('click', () => _setSelectMode(false));
  }

  // File input preview + drag-and-drop
  const resFileInput = $('resFile');
  const resDropzone  = $('resDropzone');
  function _resUpdateFileLabel(file) {
    const label = $('resFileName');
    if (label) label.textContent = file ? file.name : 'Choose a file, or drag one here…';
  }
  if (resFileInput) {
    resFileInput.addEventListener('change', () => _resUpdateFileLabel(resFileInput.files[0]));
  }
  if (resDropzone && resFileInput) {
    ['dragenter', 'dragover'].forEach(evt => {
      resDropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        resDropzone.classList.add('res-dropzone--active');
      });
    });
    ['dragleave', 'drop'].forEach(evt => {
      resDropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        resDropzone.classList.remove('res-dropzone--active');
      });
    });
    resDropzone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      resFileInput.files = e.dataTransfer.files;
      _resUpdateFileLabel(file);
    });
  }

  // Hide the "notify residents" checkbox for management-only uploads - residents
  // can't see those documents regardless, so notifying them would be misleading.
  const resVisibilitySelect = $('resVisibility');
  if (resVisibilitySelect) {
    resVisibilitySelect.addEventListener('change', () => {
      const row = $('resNotifyRow');
      if (row) row.hidden = resVisibilitySelect.value === 'management';
    });
  }

  // Upload form submit
  const resUploadBtn = $('resUploadBtn');
  if (resUploadBtn) {
    resUploadBtn.addEventListener('click', async () => {
      const title   = ($('resTitle')?.value || '').trim();
      const category  = $('resCategory')?.value  || 'General';
      const visibility = $('resVisibility')?.value || 'residents';
      const fileInput  = $('resFile');
      const file       = fileInput?.files?.[0];
      if (!title)  { toast('Please enter a document title.', true); return; }
      if (!file)   { toast('Please choose a file to upload.', true); return; }
      const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
      if (file.size > MAX_BYTES) { toast('File is too large. Maximum size is 10 MB.', true); return; }
      resUploadBtn.disabled   = true;
      resUploadBtn.textContent = 'Uploading…';
      try {
        const file_data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = e => resolve(e.target.result);
          reader.onerror = () => reject(new Error('Could not read file.'));
          reader.readAsDataURL(file);
        });
        const res  = await fetch('/api/management/resources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title, category, visibility, file_data, file_name: file.name, file_type: file.type, file_size: file.size }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Upload failed.');
        toast('Document uploaded.');

        // Cross-post to Announcements so residents notice a new document
        // without having to happen to check the Resources tab. Skipped for
        // management-only uploads, which residents can't see anyway.
        if ($('resNotify')?.checked && visibility !== 'management') {
          fetch('/api/management/announcements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              title: `New document published: ${title}`,
              body: `Management has published a new document ("${title}") in the Resources tab. Visit Resources to view or download it.`,
              category: 'General',
            }),
          }).catch(() => {}); // best-effort - the resource upload itself already succeeded
        }

        // Reset form
        if ($('resTitle'))    $('resTitle').value = '';
        if ($('resCategory')) $('resCategory').selectedIndex = 0;
        if ($('resVisibility')) $('resVisibility').selectedIndex = 0;
        if ($('resNotify'))   $('resNotify').checked = true;
        if (fileInput)        fileInput.value = '';
        if ($('resFileName')) $('resFileName').textContent = 'Choose a file, or drag one here…';
        loadMgmtResources();
      } catch (err) {
        toast(err.message, true);
      } finally {
        resUploadBtn.disabled   = false;
        resUploadBtn.textContent = 'Upload Document';
      }
    });
  }

  loadMgmtResources().catch(e => console.error('[mgmt resources]', e));
  document.querySelectorAll('[data-view="resources"]').forEach(el =>
    el.addEventListener('click', () => loadMgmtResources().catch(e => console.error('[mgmt resources]', e))));

  // Collapsible section heads
  document.querySelectorAll('[data-res-section]').forEach(head => {
    head.addEventListener('click', () => {
      const sec = document.getElementById(head.dataset.resSection);
      if (sec) sec.classList.toggle('res-section--collapsed');
    });
  });

  // Stage modal close
  const stageModal = $('stageSelectorModal');
  if (stageModal) {
    bind('stageModalClose', () => stageModal.classList.remove('open'));
    stageModal.addEventListener('click', e => { if (e.target === stageModal) stageModal.classList.remove('open'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') stageModal.classList.remove('open'); });
  }

  // Logout
  bind('logoutBtn', () => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); // clear the cookie server-side
    ['mgmtToken', 'mgmtUser', 'mgmtLastView', 'mgmtDataSnapshot'].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    // Tells client-backend.js's auto-login not to re-seed the preview session on
    // the next load — an explicit logout should reach the real sign-in screen.
    try { localStorage.setItem('lumina_mgmt_signed_out', '1'); } catch {}
    window.location.href = 'index.html';
  });

  function bind(id, h) { const el = $(id); if (el) el.addEventListener('click', h); }

})();
