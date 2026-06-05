// Frontend gate for the stewards page. Accepts EITHER:
//   - The shared admin password (same hash as admin-auth.js), OR
//   - Any steward's Torn ID, validated server-side against the Stewards sheet
//     via the verifyStewardLogin action.
//
// NOT a security boundary — the hash can be brute-forced and Torn IDs are
// public. This is a soft gate to keep casual visitors out of the stewards UI.
//
// Requires API_URL to be defined by the time the form is submitted. config.js
// is loaded at the bottom of the body, which runs before any user interaction.

(function() {
  var EXPECTED_HASH = 'f8fc5e379818a3af70b0398c2f22f0fdc0f5a570320aa1bd0f77a8df9f6eebfb';
  var SESSION_KEY = 'shootout_steward_authed';
  var STEWARD_ID_KEY = 'shootout_steward_id';
  var STEWARD_NAME_KEY = 'shootout_steward_name';

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

  function buildLockScreen() {
    var overlay = document.createElement('div');
    overlay.id = 'stewardLockOverlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:#0f1115', 'color:#e8e8e8',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:"DM Sans",system-ui,sans-serif', 'visibility:visible'
    ].join(';');

    overlay.innerHTML =
      '<form id="stewardLockForm" style="background:#1a1d24;border:1px solid #2a2f3a;padding:32px;border-radius:8px;display:flex;flex-direction:column;gap:14px;min-width:320px;max-width:360px;">' +
      '  <div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#e8a832;">Steward access</div>' +
      '  <div style="font-size:12px;color:#8b8f99;line-height:1.5;">Enter your Torn ID or the admin password.</div>' +
      '  <input id="stewardLockInput" type="password" placeholder="Torn ID or password" autocomplete="off" style="padding:10px 12px;background:#0f1115;border:1px solid #2a2f3a;color:#e8e8e8;border-radius:4px;font-size:14px;font-family:inherit;outline:none;" />' +
      '  <button type="submit" id="stewardLockSubmit" style="padding:10px 12px;background:#e8a832;border:none;color:#0f1115;border-radius:4px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;">Unlock</button>' +
      '  <div id="stewardLockError" style="font-size:12px;color:#d94848;min-height:14px;"></div>' +
      '</form>';

    return overlay;
  }

  function mount() {
    hideBody();
    document.documentElement.appendChild(buildLockScreen());
    document.documentElement.style.visibility = '';
    var body = document.body;
    if (body) body.style.visibility = 'hidden';

    var form = document.getElementById('stewardLockForm');
    var input = document.getElementById('stewardLockInput');
    var submitBtn = document.getElementById('stewardLockSubmit');
    var error = document.getElementById('stewardLockError');
    input.focus();

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      error.textContent = '';
      var entered = input.value;
      if (!entered) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Checking…';

      try {
        // 1. Try admin password (client-side hash check, instant)
        var hash = await sha256Hex(entered);
        if (hash === EXPECTED_HASH) {
          try { localStorage.setItem(SESSION_KEY, '1'); } catch (_) {}
          try {
            localStorage.removeItem(STEWARD_ID_KEY);
            localStorage.removeItem(STEWARD_NAME_KEY);
          } catch (_) {}
          unlock();
          return;
        }

        // 2. Try steward Torn ID (validated server-side against Stewards sheet)
        if (typeof API_URL !== 'string' || !API_URL) {
          throw new Error('API_URL not configured');
        }
        var url = API_URL + '?action=verifyStewardLogin&password=' + encodeURIComponent(entered);
        var res = await fetch(url);
        var data = await res.json();
        if (data && data.ok) {
          try {
            localStorage.setItem(SESSION_KEY, '1');
            localStorage.setItem(STEWARD_ID_KEY, data.stewardId || '');
            localStorage.setItem(STEWARD_NAME_KEY, data.name || '');
          } catch (_) {}
          unlock();
          return;
        }

        error.textContent = 'Wrong password';
        input.select();
      } catch (err) {
        error.textContent = 'Login failed: ' + (err.message || String(err));
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock';
      }
    });
  }

  function unlock() {
    var overlay = document.getElementById('stewardLockOverlay');
    if (overlay) overlay.remove();
    if (document.body) document.body.style.visibility = '';
    // Fire a custom event so the page can read who logged in
    try {
      var detail = {
        stewardId: localStorage.getItem(STEWARD_ID_KEY) || '',
        stewardName: localStorage.getItem(STEWARD_NAME_KEY) || ''
      };
      document.dispatchEvent(new CustomEvent('steward-auth-unlocked', { detail: detail }));
    } catch (_) {}
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
