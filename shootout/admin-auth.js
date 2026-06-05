// Frontend-only gate for the admin pages. The page body is hidden until the
// user enters a password that matches the SHA-256 hash below. Once verified,
// a flag is stored in localStorage so the login is remembered across reloads,
// tabs, and browser restarts. NOT a security boundary — anyone reading source can see the hash
// and brute-force a short password, and the Apps Script API is still open
// to anyone who finds the /exec URL.
//
// To change the password: open devtools on this page, run
//   await window.__hashAdminPassword('your-new-password')
// then paste the returned hex into EXPECTED_HASH below.

(function() {
  var EXPECTED_HASH = 'f8fc5e379818a3af70b0398c2f22f0fdc0f5a570320aa1bd0f77a8df9f6eebfb';
  var SESSION_KEY = 'shootout_admin_authed';

  async function sha256Hex(str) {
    var buf = new TextEncoder().encode(str);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(function(b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  window.__hashAdminPassword = sha256Hex;

  function hideBody() {
    document.documentElement.style.visibility = 'hidden';
  }

  function showBody() {
    document.documentElement.style.visibility = '';
  }

  function buildLockScreen() {
    var overlay = document.createElement('div');
    overlay.id = 'adminLockOverlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:#0f1115', 'color:#e8e8e8',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:"DM Sans",system-ui,sans-serif', 'visibility:visible'
    ].join(';');

    overlay.innerHTML =
      '<form id="adminLockForm" style="background:#1a1d24;border:1px solid #2a2f3a;padding:32px;border-radius:8px;display:flex;flex-direction:column;gap:14px;min-width:300px;">' +
      '  <div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#e8a832;">Admin access</div>' +
      '  <input id="adminLockInput" type="password" placeholder="Password" autocomplete="off" style="padding:10px 12px;background:#0f1115;border:1px solid #2a2f3a;color:#e8e8e8;border-radius:4px;font-size:14px;font-family:inherit;outline:none;" />' +
      '  <button type="submit" style="padding:10px 12px;background:#e8a832;border:none;color:#0f1115;border-radius:4px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;">Unlock</button>' +
      '  <div id="adminLockError" style="font-size:12px;color:#d94848;min-height:14px;"></div>' +
      '</form>';

    return overlay;
  }

  function mount() {
    hideBody();
    document.documentElement.appendChild(buildLockScreen());
    document.documentElement.style.visibility = '';
    var body = document.body;
    if (body) body.style.visibility = 'hidden';

    var form = document.getElementById('adminLockForm');
    var input = document.getElementById('adminLockInput');
    var error = document.getElementById('adminLockError');
    input.focus();

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      error.textContent = '';
      var entered = input.value;
      if (!entered) return;
      var hash = await sha256Hex(entered);
      if (hash === EXPECTED_HASH) {
        try { localStorage.setItem(SESSION_KEY, '1'); } catch (_) {}
        unlock();
      } else {
        error.textContent = 'Wrong password';
        input.select();
      }
    });
  }

  function unlock() {
    var overlay = document.getElementById('adminLockOverlay');
    if (overlay) overlay.remove();
    if (document.body) document.body.style.visibility = '';
  }

  function init() {
    try {
      if (localStorage.getItem(SESSION_KEY) === '1') return;
    } catch (_) {}

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  }

  init();
})();
