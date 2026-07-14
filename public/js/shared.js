// Shared across all 3 portal controllers (loaded before each one).
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Each portal's toast() used to be a near-identical copy with real differences
// baked in (target element id, how the 2nd arg maps to a CSS class, how long it
// stays up) - this factory keeps those differences explicit per caller instead
// of silently unifying them, while still sharing the actual show/hide mechanics.
function makeToast(elementId, { duration = 3500, resolveClass } = {}) {
  let timer;
  return function toast(msg, classOrFlag) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = msg;
    el.className = 'show ' + (resolveClass ? resolveClass(classOrFlag) : (classOrFlag || ''));
    clearTimeout(timer);
    timer = setTimeout(() => { el.className = ''; }, duration);
  };
}

// Shared date formatter (was previously only defined in portal.controller.js -
// moved verbatim, including the ' - ' fallback and the lack of an explicit
// timeZone: the app's date strings are already SGT calendar dates like
// "2026-07-14", and appending T00:00:00 + formatting in the browser's own
// local zone is what every existing caller already relies on).
function fmtDate(iso) {
  if (!iso) return ' - ';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
