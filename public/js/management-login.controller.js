// management-login.controller.js  (served at /js/management-login.controller.js)
// Client-side controller for management-login.html.
// Authenticates against the backend: POST /api/auth/management/login.

const landingBtn = document.getElementById('signInLanding');
const formWrap   = document.getElementById('formWrap');
const submitBtn  = document.getElementById('submitBtn');
const errMsg     = document.getElementById('errMsg');
const usernameEl = document.getElementById('username');
const passwordEl = document.getElementById('password');

// Already signed in? Skip to the console.
if (sessionStorage.getItem('mgmtToken') || localStorage.getItem('mgmtToken')) {
  window.location.href = 'management.html';
}

landingBtn.addEventListener('click', () => {
  landingBtn.style.display = 'none';
  formWrap.classList.add('open');
  setTimeout(() => usernameEl.focus(), 350);
});

async function doLogin() {
  errMsg.textContent = '';
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) { errMsg.textContent = 'Please enter your username and password.'; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'SIGNING IN…';
  try {
    const res  = await fetch('/api/auth/management/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.success) { errMsg.textContent = data.message || 'Invalid credentials.'; return; }

    sessionStorage.setItem('mgmtToken', data.token);
    sessionStorage.setItem('mgmtUser',  JSON.stringify(data.user));
    localStorage.setItem('mgmtToken', data.token);
    localStorage.setItem('mgmtUser',  JSON.stringify(data.user));
    window.location.href = 'management.html';
  } catch {
    errMsg.textContent = 'Connection error. Please try again.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'SIGN IN';
  }
}

submitBtn.addEventListener('click', doLogin);
passwordEl.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
usernameEl.addEventListener('keydown', e => { if (e.key === 'Enter') passwordEl.focus(); });

// Theme toggle
(function () {
  const KEY = 'meridian-mgmt-theme';
  function sync(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach(el => {
      el.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
    });
  }
  sync(document.documentElement.dataset.theme || 'dark');
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(KEY, next);
      sync(next);
    });
  });
})();
