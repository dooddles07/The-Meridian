(function () {
  'use strict';

  // verify.controller.js - Guardhouse Portal
  // Auth: POST /api/auth/guardhouse/login - see backend/.env.example for the
  // LUMINA_GUARDHOUSE account(s), there's no fixed default credential.
  // QR decode: jsQR library (loaded by the page)
  // Log: persisted in MongoDB, shared live across every guard station - it
  // never auto-resets; defaults to showing today's entries (see _logRange
  // below), with a toggle to pull up full history, and a manual Clear button
  // scoped to whichever range is currently active.

  const GH_SESS = 'gh_session';
  const $ = id => document.getElementById(id);

  // Holds the most recently scanned valid pass (for the check-in tag call).
  let _currentPass = null;

  // Session
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(GH_SESS) || 'null'); } catch {}
  // NOTE: auto-boot is deferred to the end of this IIFE (see bottom). showPortal()
  // → renderLog() reads top-level consts declared later (e.g. esc); calling it here
  // would hit a temporal-dead-zone error for restored sessions.

  // Authenticated fetch — mirrors portal.controller.js's identical pattern. A
  // 401 on a non-login API call means the session cookie is gone/expired (past
  // its 8h TTL, or revoked): bounce back to the login screen instead of leaving
  // the parcel/guest lookups silently failing forever.
  let _authExpiredHandled = false;
  const _rawFetch = window.fetch.bind(window);
  function fetch(url, opts = {}) {
    return _rawFetch(url, opts).then(res => {
      if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/auth/')) {
        handleAuthExpired();
      }
      return res;
    });
  }
  function handleAuthExpired() {
    if (_authExpiredHandled) return; // avoid a storm of reloads from parallel calls
    _authExpiredHandled = true;
    _rawFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'guardhouse' }) }).catch(() => {});
    sessionStorage.removeItem(GH_SESS);
    try { localStorage.setItem('lumina_gh_logout_broadcast', String(Date.now())); } catch {}
    window.location.reload();
  }
  // Cross-tab/station logout sync - see portal.controller.js's identical
  // rationale: the `storage` event fires in every OTHER same-origin tab the
  // instant one station's session expires or logs out.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'lumina_gh_logout_broadcast' || !e.newValue) return;
    if (!sessionStorage.getItem(GH_SESS)) return; // this tab isn't logged in anyway
    window.location.reload();
  });

  // Login — a real <form> wraps these fields, so Enter-to-submit and native
  // required-field validation come from the browser for free.
  $('ghLoginForm').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
  // Enter in the username field advances to password instead of submitting
  // early with an empty one - must preventDefault or the form would submit too.
  $('ghUsername').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('ghPassword').focus(); } });

  async function doLogin() {
    const username = $('ghUsername').value.trim();
    const password = $('ghPassword').value;
    const errEl    = $('ghLoginErr');
    const btn      = $('ghLoginBtn');
    if (!username || !password) { errEl.textContent = 'Please enter your username and password.'; return; }
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const res  = await fetch('/api/auth/guardhouse/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.success) { errEl.textContent = data.message || 'Invalid credentials.'; return; }
      // The session cookie is already set by the server on this same response -
      // nothing to store client-side beyond the (non-secret) display info below.
      sessionStorage.setItem(GH_SESS, JSON.stringify(data));
      session = data;
      showPortal();
    } catch {
      errEl.textContent = 'Connection error. Please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  }

  function showPortal() {
    $('gh-login').style.display  = 'none';
    $('gh-portal').style.display = 'flex';
    startClock();
    renderLog();
    // Live: poll the shared log so entries from other stations appear without a reload.
    if (!_logPoll) _logPoll = setInterval(renderLog, 8000);
  }

  // Logout
  $('ghLogout').addEventListener('click', () => {
    stopCamera();
    _rawFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'guardhouse' }) }).catch(() => {}); // clear the cookie server-side
    sessionStorage.removeItem(GH_SESS);
    try { localStorage.setItem('lumina_gh_logout_broadcast', String(Date.now())); } catch {}
    window.location.href = 'index.html';
  });

  // Live clock
  function startClock() {
    function tick() {
      const now  = new Date();
      const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Singapore' });
      const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
      $('ghClock').textContent = time;
      $('ghDate').textContent  = date;
    }
    tick(); setInterval(tick, 1000);
  }

  // Camera / QR scanning
  let _stream     = null;
  let _scanLoop   = null;
  let _lastResult = '';
  let _lastTime   = 0;

  const video    = $('ghVideo');
  const canvas   = $('ghCanvas');
  const ctx      = canvas.getContext('2d', { willReadFrequently: true });
  const camBtn   = $('ghCamBtn');
  const idle     = $('ghFinderIdle');
  const scanline = $('ghScanline');

  camBtn.addEventListener('click', () => { _stream ? stopCamera() : startCamera(); });

  async function startCamera() {
    try {
      _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = _stream;
      await video.play();
      idle.style.display    = 'none';
      scanline.style.display = 'block';
      camBtn.innerHTML      = '<span class="material-symbols-outlined" aria-hidden="true">stop_circle</span> Stop Camera';
      camBtn.classList.add('stop');
      _scanLoop = requestAnimationFrame(scanFrame);
    } catch {
      toast('Camera access denied or unavailable.', 'err');
    }
  }

  function stopCamera() {
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    if (_scanLoop) { cancelAnimationFrame(_scanLoop); _scanLoop = null; }
    video.srcObject = null;
    idle.style.display     = 'flex';
    scanline.style.display = 'none';
    camBtn.innerHTML       = '<span class="material-symbols-outlined" aria-hidden="true">photo_camera</span> Start Camera';
    camBtn.classList.remove('stop');
  }

  function scanFrame() {
    if (!_stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code    = window.jsQR && window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const now = Date.now();
        if (code.data !== _lastResult || now - _lastTime > 4000) {
          _lastResult = code.data;
          _lastTime   = now;
          verifyReference(code.data);
        }
      }
    }
    _scanLoop = requestAnimationFrame(scanFrame);
  }

  // Manual entry
  $('ghManualBtn').addEventListener('click', () => {
    const val = $('ghManualInput').value.trim();
    if (!val) { toast('Enter a guest reference to verify.', 'err'); return; }
    verifyReference(val);
    $('ghManualInput').value = '';
  });
  $('ghManualInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('ghManualBtn').click();
  });

  // QR Processor
  // Expected format (generated by resident portal):
  //   LUMINA-GUEST
  //   Host Unit: #05-12
  //   Visitor: John Doe
  //   Date: 2026-06-05
  //
  // Any valid LUMINA-GUEST payload is admitted; anything else is denied.

  // Today's date in Singapore time as YYYY-MM-DD (matches the pass Date format).
  function todaySGT() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  }

  // The QR/manual input is a guest REFERENCE (e.g. GST-20260620-1234). Old
  // multi-line passes are still handled by pulling their "Ref:" line.
  function extractReference(raw) {
    const txt = String(raw || '').trim();
    const refLine = txt.split(/\n/).map(l => l.trim()).find(l => l.startsWith('Ref:'));
    return (refLine ? refLine.replace('Ref:', '').trim() : txt);
  }

  // Verify a reference: look it up, then gate by the scheduled visit date.
  async function verifyReference(raw) {
    const reference = extractReference(raw);
    _currentPass = null;
    if (!reference) {
      showResult('INVALID - Deny Entry', 'red', { 'Reason': 'No reference provided', 'Scanned At': nowSGT() });
      return;
    }

    showResult('Verifying…', 'grey', { 'Reference': reference, 'Status': 'Checking with the system…' });

    let data;
    try {
      const token = (session && session.token) || '';
      const res = await fetch('/api/guardhouse/lookup?reference=' + encodeURIComponent(reference), {
        headers: { Authorization: `Bearer ${token}` },
      });
      data = await res.json();
    } catch {
      showResult('ERROR - Try Again', 'red', { 'Reference': reference, 'Reason': 'Could not reach the verification server' });
      return;
    }

    if (!data || !data.success || !data.found) {
      showResult('INVALID - Deny Entry', 'red', { 'Reference': reference, 'Reason': 'No matching guest pass found', 'Scanned At': nowSGT() });
      addLog({ type: 'red', label: 'Denied', name: reference, meta: 'No matching pass' });
      return;
    }

    // Date gate: only guards ADMISSION (still Registered, hasn't arrived yet).
    // Once a pass has actually been checked in, the stage itself is proof the
    // visit is legitimate - a Multi-Day/Long-Term guest must still be able to
    // check out or be marked departed on a later calendar day, so the gate
    // must not re-apply to those lookups.
    const today = todaySGT();
    if (data.stage === 'Registered' && data.visitDate && data.visitDate !== today) {
      const future = data.visitDate > today;
      const title  = future ? 'NOT VALID YET - Deny Entry' : 'EXPIRED - Deny Entry';
      const reason = future ? `Scheduled for ${data.visitDate} - not valid until then` : `Pass was for ${data.visitDate} and has expired`;
      showResult(title, 'red', { 'Reference': data.reference, 'Visitor': data.visitor, 'Host Unit': data.hostUnit, 'Scheduled': data.visitDate, 'Today': today, 'Reason': reason });
      addLog({ type: 'red', label: 'Denied', name: data.visitor || data.reference, meta: `${data.reference} · ${future ? 'not yet' : 'expired'} (${data.visitDate})` });
      return;
    }

    // What's actionable next depends on where the pass already is in its
    // lifecycle - a guard re-scanning a Checked-In guest is checking them out,
    // not admitting them again.
    // Titles read as a status + the imperative for what to do about it, same
    // pattern as the invalid/expired cases above; button labels stay
    // imperative too (Admit, not Admitted) - the past-tense version is what
    // the toast/log say once it's done.
    const STAGE_UI = {
      'Registered':  { title: 'VALID - Admit Visitor',        verb: 'checkin',  label: 'Admit',        icon: 'check_circle' },
      'Checked In':  { title: 'ON SITE - Check Guest Out',     verb: 'checkout', label: 'Check Out',    icon: 'logout' },
      'Checked Out': { title: 'CHECKED OUT - Confirm Departure', verb: 'depart', label: 'Mark Departed',icon: 'directions_walk' },
    };
    const ui = STAGE_UI[data.stage];
    _currentPass = { ref: data.reference, hostId: data.hostContactId, oppId: data.opportunityId, visitor: data.visitor, hostUnit: data.hostUnit };

    if (!ui) {
      // Departed / Closed - nothing left to action at the gate.
      const closed = data.stage === 'Closed';
      showResult(closed ? 'PASS CLOSED - Deny Entry' : 'DEPARTED - Visit Complete', closed ? 'red' : 'grey',
        { 'Reference': data.reference, 'Visitor': data.visitor || '', 'Host Unit': data.hostUnit || '', 'Status': data.stage },
        [{ cls: 'log', verb: 'noted', icon: 'note_add', label: 'Note Only' }]);
      return;
    }

    // Only show identity/vehicle/contact rows the pass actually carries - a
    // blank "IC: -" row is noise the guard has to read past.
    const fields = { 'Reference': data.reference, 'Visitor': data.visitor || '', 'Host Unit': data.hostUnit || '' };
    if (data.visitorIc)      fields['IC / Passport'] = data.visitorIc;
    if (data.visitorVehicle) fields['Vehicle'] = data.visitorVehicle;
    if (data.visitorPhone)   fields['Phone'] = data.visitorPhone;
    fields['Visit Date'] = data.visitDate || ' - ';
    fields['Verified At'] = nowSGT();
    showResult(ui.title, 'green', fields,
      [{ cls: 'admit', verb: ui.verb, icon: ui.icon, label: ui.label },
       { cls: 'log',   verb: 'noted', icon: 'note_add', label: 'Note Only' }]);
  }

  // `actions` (when given) is the button set for this result - lets callers
  // offer checkout/depart instead of always admit/deny. Omitted only by the
  // plain invalid/expired/error paths below, which always just deny + note.
  function showResult(title, color, fields, actions) {
    $('ghStatusDot').className   = `gh-result-status ${color}`;
    $('ghStatusTitle').className = `gh-result-title ${color}`;
    $('ghStatusTitle').textContent = title;

    const rows = Object.entries(fields).map(([k, v]) =>
      `<div class="gh-row"><span class="gh-row-key">${k}</span><span class="gh-row-val ${k === 'Visitor' ? 'gold' : ''}">${esc(v)}</span></div>`
    ).join('');

    const icon = n => `<span class="material-symbols-outlined" aria-hidden="true">${n}</span>`;
    const list = actions || [
      { cls: 'deny', verb: 'denied', icon: 'cancel',  label: 'Deny Entry' },
      { cls: 'log',  verb: 'noted',  icon: 'warning', label: 'Note & Escalate' },
    ];
    const admitBtns = `<div class="gh-result-actions">${list.map(a =>
      `<button class="gh-action ${a.cls}" data-verb="${a.verb}">${icon(a.icon)} ${esc(a.label)}</button>`
    ).join('')}</div>`;

    $('ghResultBody').innerHTML = `<div>${rows}</div>${admitBtns}`;
  }
  // Delegated on the stable container (its innerHTML gets replaced on every
  // scan) rather than inline onclick="" on the generated buttons - keeps
  // logAction a normal closure function instead of a required window.* global,
  // consistent with how every other handler in this file is wired.
  $('ghResultBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-verb]');
    if (btn) logAction(btn.dataset.verb);
  });

  // Every verb the gate can act on - what it logs as, whether it calls the
  // real check-in/out/depart endpoint, and how the toast reads.
  const VERB_META = {
    checkin:  { logType: 'green',  text: 'Entry Admitted',  backendAction: 'checkin',  toast: 'ok'  },
    checkout: { logType: 'green',  text: 'Checked Out',     backendAction: 'checkout', toast: 'ok'  },
    depart:   { logType: 'green',  text: 'Marked Departed', backendAction: 'depart',   toast: 'ok'  },
    denied:   { logType: 'red',    text: 'Entry Denied',    backendAction: null,       toast: 'err' },
    noted:    { logType: 'orange', text: 'Noted',           backendAction: null,       toast: 'err' },
  };

  async function logAction(verb) {
    const meta = VERB_META[verb] || VERB_META.noted;
    // Capture the pass this click is acting on - if a new QR gets scanned while
    // this action's request is still in flight, _currentPass will point at
    // THAT one instead, and we must not act on or clear the wrong pass.
    const pass = _currentPass;
    const btns = document.querySelectorAll('.gh-result-actions .gh-action');
    btns.forEach(b => b.disabled = true);

    // checkin/checkout/depart move the guest's real stage - this must be
    // CONFIRMED by the backend before telling the guard it worked. This used
    // to be fire-and-forget: the success toast fired immediately regardless of
    // the outcome, so a failed check-in looked identical to a successful one -
    // the only failure signal was a devtools console.warn no guard would ever
    // see, meaning a resident's guest could be silently left un-admitted in
    // the system while the guard believed the gate had let them through.
    if (meta.backendAction && pass && (pass.oppId || pass.ref)) {
      const token = (session && session.token) || '';
      try {
        const res = await fetch('/api/guardhouse/checkin', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:    JSON.stringify({
            opportunity_id: pass.oppId || '',
            reference:      pass.ref   || '',
            action:         meta.backendAction,
          }),
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.message || '');
      } catch (err) {
        toast(err.message || `Could not confirm - please try again.`, 'err');
        btns.forEach(b => b.disabled = false);
        return; // keep the result panel + pass so the guard can retry
      }
    }

    // Shared activity log - recorded only once the action is actually
    // confirmed (or immediately for gate-only denied/noted decisions, which
    // have no backend action to confirm).
    if (pass && pass.ref) {
      addLog({ key: `guest:${pass.ref}`, type: meta.logType, label: meta.text,
               name: pass.visitor || pass.ref,
               meta: `${pass.ref}${pass.hostUnit ? ' · Unit ' + pass.hostUnit : ''}` });
    }

    if (_currentPass === pass) _currentPass = null;
    toast(meta.text, meta.toast);
    resetResult();
  }

  function resetResult() {
    $('ghStatusDot').className   = 'gh-result-status grey';
    $('ghStatusTitle').className = 'gh-result-title grey';
    $('ghStatusTitle').textContent = 'Awaiting scan';
    $('ghResultBody').innerHTML  = '<div class="gh-result-idle">Scan a QR code or enter a payload manually to verify a visitor pass.</div>';
  }

  // Parcel checker
  let _parcel = null; // { reference, opportunityId, resident, unit, stage, _override }
  // Friendly labels so the badge matches the button vocabulary.
  const PARCEL_LABEL = {
    'Received':               'Received',
    'Notified':               'Notified',
    'Collected':              'Collected',
    'Uncollected / Returned': 'Uncollected',
  };
  const PARCEL_STAGE_CLASS = {
    'Received':               'amber',
    'Notified':               'amber',
    'Collected':              'green',
    'Uncollected / Returned': 'red',
  };
  // Stages that finalise a parcel - locked from further changes unless overridden.
  const PARCEL_LOCKED = ['Collected', 'Uncollected / Returned'];
  if ($('ghParcelBtn')) $('ghParcelBtn').addEventListener('click', checkParcel);
  if ($('ghParcelInput')) $('ghParcelInput').addEventListener('keydown', e => { if (e.key === 'Enter') checkParcel(); });

  async function checkParcel() {
    const reference = extractReference($('ghParcelInput').value.trim()) || $('ghParcelInput').value.trim();
    const box = $('ghParcelResult');
    if (!reference) { toast('Enter a parcel reference to check.', 'err'); return; }
    box.style.display = 'block';
    box.innerHTML = `<div class="gh-parcel-line">Looking up <strong>${esc(reference)}</strong>…</div>`;
    try {
      const token = (session && session.token) || '';
      const res   = await fetch('/api/guardhouse/parcel?reference=' + encodeURIComponent(reference), { headers: { Authorization: `Bearer ${token}` } });
      const data  = await res.json();
      if (!data.success) { box.innerHTML = `<div class="gh-parcel-line err">${esc(data.message || 'Lookup failed.')}</div>`; return; }
      if (!data.found)   { box.innerHTML = `<div class="gh-parcel-line err">No parcel found for "${esc(reference)}".</div>`; _parcel = null; return; }
      _parcel = data;
      renderParcel();
    } catch {
      box.innerHTML = `<div class="gh-parcel-line err">Could not reach the server. Try again.</div>`;
    }
  }

  function renderParcel() {
    const p = _parcel; if (!p) return;
    const label  = PARCEL_LABEL[p.stage] || p.stage;
    const cls    = PARCEL_STAGE_CLASS[p.stage] || 'grey';
    const locked = PARCEL_LOCKED.includes(p.stage) && !p._override;
    const body = locked
      ? `<div class="gh-parcel-locked">
           Finalised as <strong>${esc(label)}</strong> - locked.
           <button class="gh-parcel-override" data-parcel-override>Override status</button>
         </div>`
      : `<div class="gh-parcel-actions">
           <button class="gh-parcel-btn hold"        data-parcel-status="received">Received</button>
           <button class="gh-parcel-btn collected"   data-parcel-status="collected">Collected</button>
           <button class="gh-parcel-btn uncollected" data-parcel-status="uncollected">Uncollected</button>
         </div>`;
    const collectorRow = p.authorizedCollector
      ? `<div class="gh-parcel-collector"><span class="material-symbols-outlined" style="font-size:0.9rem;vertical-align:-2px">person_check</span> Auth. collector: <strong>${esc(p.authorizedCollector)}</strong></div>`
      : '';
    $('ghParcelResult').innerHTML = `
      <div class="gh-parcel-card">
        <div class="gh-parcel-head">
          <div>
            <div class="gh-parcel-ref">${esc(p.reference)}</div>
            <div class="gh-parcel-sub">${esc(p.resident || ' - ')}${p.unit ? ' · #' + esc(p.unit) : ''}</div>
            ${collectorRow}
          </div>
          <span class="gh-parcel-stage ${cls}">${esc(label)}</span>
        </div>
        ${body}
      </div>`;
  }

  // Delegated on the stable container, same rationale as ghResultBody above -
  // checkParcel() also rewrites this element's innerHTML directly on lookup/
  // error, so binding here (once) rather than on the generated buttons
  // survives every one of those rewrites.
  $('ghParcelResult').addEventListener('click', e => {
    if (e.target.closest('[data-parcel-override]')) { parcelOverride(); return; }
    const statusBtn = e.target.closest('[data-parcel-status]');
    if (statusBtn) parcelStatus(statusBtn.dataset.parcelStatus);
  });

  function parcelOverride() { if (_parcel) { _parcel._override = true; renderParcel(); } }

  async function parcelStatus(status) {
    if (!_parcel) return;
    const token = (session && session.token) || '';
    const box   = $('ghParcelResult');
    box.querySelectorAll('.gh-parcel-btn, .gh-parcel-override').forEach(b => b.disabled = true);
    try {
      const res  = await fetch('/api/guardhouse/parcel/status', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ opportunity_id: _parcel.opportunityId, reference: _parcel.reference, status }),
      });
      const data = await res.json();
      if (!data.success) { toast(data.message || 'Update failed.', 'err'); renderParcel(); return; }
      _parcel.stage     = data.stage;
      _parcel._override = false;  // re-lock if it's now a finalised stage
      renderParcel();
      const friendly = PARCEL_LABEL[data.stage] || data.stage;
      addLog({ cat: 'parcel', key: `parcel:${_parcel.reference}`, type: status === 'uncollected' ? 'red' : 'green', label: friendly, name: _parcel.reference, meta: `${_parcel.resident}${_parcel.unit ? ' · #' + _parcel.unit : ''}` });
      toast(`Parcel marked "${friendly}".`, status === 'uncollected' ? 'err' : 'ok');
    } catch {
      toast('Connection error. Please try again.', 'err');
      renderParcel();
    }
  }

  // Visitor & parcel log (shared + live across all stations)
  // The log is persisted in MongoDB and polled, so every guardhouse device shows the
  // same feed and a check-in/parcel action on one station appears on the others.
  // Entries with a `key` (e.g. a parcel reference) update that single row server-side.
  const _logToken   = () => (session && session.token) || '';
  const _logHeaders = (json) => json
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${_logToken()}` }
    : { Authorization: `Bearer ${_logToken()}` };
  let _logEntries = [];
  let _logPoll    = null;
  // 'today' (default) or 'all' - which slice of the permanent log is currently
  // shown. Toggled via the Today/All History buttons; both log panels share
  // this one setting since they're fed by the same request.
  let _logRange = 'today';

  function setLogRange(range) {
    if (range !== 'today' && range !== 'all') return;
    _logRange = range;
    if ($('ghRangeToday')) { $('ghRangeToday').classList.toggle('active', range === 'today'); $('ghRangeToday').setAttribute('aria-pressed', String(range === 'today')); }
    if ($('ghRangeAll'))   { $('ghRangeAll').classList.toggle('active',   range === 'all');   $('ghRangeAll').setAttribute('aria-pressed',   String(range === 'all')); }
    if ($('ghLogTitle'))       $('ghLogTitle').textContent       = range === 'today' ? "Today's Visitor Log" : 'All Visitor History';
    if ($('ghParcelLogTitle')) $('ghParcelLogTitle').textContent = range === 'today' ? "Today's Parcel Log"  : 'All Parcel History';
    renderLog();
  }
  if ($('ghRangeToday')) $('ghRangeToday').addEventListener('click', () => setLogRange('today'));
  if ($('ghRangeAll'))   $('ghRangeAll').addEventListener('click',   () => setLogRange('all'));

  // Function declarations (hoisted) - safe to call from showPortal() at startup.
  async function addLog(entry) {
    try {
      await fetch('/api/guardhouse/log', { method: 'POST', headers: _logHeaders(true), body: JSON.stringify(entry) });
    } catch { /* non-fatal - the action itself already succeeded */ }
    renderLog();
  }

  function entryHtml(e) {
    return `
      <div class="gh-entry">
        <div class="gh-entry-dot ${e.type}"></div>
        <div class="gh-entry-main">
          <div class="gh-entry-name">${esc(e.name)}</div>
          <div class="gh-entry-meta">${esc(e.meta)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.25rem">
          <span class="gh-entry-tag ${e.type}">${esc(e.label)}</span>
          <span class="gh-entry-time">${esc(e.time)}</span>
        </div>
      </div>`;
  }

  async function renderLog() {
    try {
      const d = await fetch(`/api/guardhouse/log?range=${_logRange}`, { headers: _logHeaders() }).then(r => r.json());
      if (d && d.success) _logEntries = d.entries || [];
    } catch { /* keep the last-rendered entries on a transient failure */ }
    const list    = _logEntries;
    const parcels = list.filter(e => e.cat === 'parcel');
    const guests  = list.filter(e => e.cat !== 'parcel');
    const emptySuffix = _logRange === 'today' ? ' today' : '';

    $('ghLogCount').textContent = guests.length + (guests.length === 1 ? ' entry' : ' entries');
    $('ghLogBody').innerHTML = guests.length
      ? guests.map(entryHtml).join('')
      : `<div class="gh-log-empty"><div class="gh-log-empty-icon"><span class="material-symbols-outlined">assignment</span></div><div class="gh-log-empty-text">No visitors logged${emptySuffix}</div></div>`;

    if ($('ghParcelLogCount')) $('ghParcelLogCount').textContent = parcels.length + (parcels.length === 1 ? ' entry' : ' entries');
    if ($('ghParcelLogBody')) {
      $('ghParcelLogBody').innerHTML = parcels.length
        ? parcels.map(entryHtml).join('')
        : `<div class="gh-log-empty"><div class="gh-log-empty-icon"><span class="material-symbols-outlined">inventory_2</span></div><div class="gh-log-empty-text">No parcels logged${emptySuffix}</div></div>`;
    }
  }

  // Clear entries of one category, scoped to whichever range is currently
  // shown - clearing "Today" never touches older history, and wiping the full
  // permanent history (while viewing "All") gets its own, more serious
  // confirmation copy since that's a real destructive action now that the log
  // no longer auto-resets.
  if ($('ghClearBtn')) $('ghClearBtn').addEventListener('click', async () => {
    const wipingAll = _logRange === 'all';
    const msg = wipingAll
      ? 'Permanently delete ALL visitor log history (not just today)? This cannot be undone.'
      : "Clear today's visitor log entries?";
    if (!confirm(msg)) return;
    try { await fetch(`/api/guardhouse/log?scope=guest&range=${_logRange}`, { method: 'DELETE', headers: _logHeaders() }); } catch {}
    renderLog(); toast(wipingAll ? 'Visitor history cleared.' : "Today's visitor log cleared.");
  });
  if ($('ghParcelClearBtn')) $('ghParcelClearBtn').addEventListener('click', async () => {
    const wipingAll = _logRange === 'all';
    const msg = wipingAll
      ? 'Permanently delete ALL parcel log history (not just today)? This cannot be undone.'
      : "Clear today's parcel log entries?";
    if (!confirm(msg)) return;
    try { await fetch(`/api/guardhouse/log?scope=parcel&range=${_logRange}`, { method: 'DELETE', headers: _logHeaders() }); } catch {}
    renderLog(); toast(wipingAll ? 'Parcel history cleared.' : "Today's parcel log cleared.");
  });

  // Helpers
  function nowSGT() {
    return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Singapore' });
  }
  let _t;
  function toast(msg, type) {
    const el = $('ghToast'); if (!el) return;
    el.textContent = msg; el.className = 'show ' + (type || '');
    clearTimeout(_t); _t = setTimeout(() => { el.className = ''; }, 3000);
  }

  // Restore an existing session and boot the portal LAST - after every top-level
  // const above is initialized - so showPortal()/renderLog() can safely read them.
  if (session) showPortal();
  else $('ghUsername').focus(); // land keyboard focus straight on the first field

})();
