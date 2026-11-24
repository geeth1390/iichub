'use strict';
// Shared by every screen.
//  * Buttons say what they do with data-act="name" (and data-arg="value");
//    each page lists its handlers in window.ACTIONS. No inline handlers,
//    so the browser can block any injected script.
//  * Enter inside a form field presses that form's main (.go) button.
(function () {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = (window.ACTIONS || {})[el.dataset.act];
    if (typeof fn !== 'function') return;
    // Real links (href="#/…") still navigate; href="#" ones are buttons.
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    if (!href || href === '#') e.preventDefault();
    let arg = el.dataset.arg;
    if (arg !== undefined && /^-?\d+$/.test(arg)) arg = Number(arg);
    fn(arg, el, e);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || ['checkbox', 'radio', 'button'].includes(t.type)) return;
    const scope = t.closest('[data-form]');
    if (!scope) return;
    const btn = scope.querySelector('button.go:not([disabled]), button.primary:not([disabled])');
    if (btn) { e.preventDefault(); btn.click(); }
  });

  window.escapeHtml = function (value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  };

  // Calls the API. Sends the session token; on "session ended" the page
  // decides what to do via onSessionEnded.
  window.makeApi = function ({ getToken, onSessionEnded }) {
    return async function api(url, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const token = getToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      const body = options.body !== undefined && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
      let response;
      try {
        response = await fetch(url, { ...options, headers, body });
      } catch {
        throw new Error('Could not reach the server. Check your connection.');
      }
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!response.ok) {
        const err = new Error(data.error || data.message || `Request failed (${response.status})`);
        err.status = response.status;
        err.code = data.code;
        if (response.status === 401 && token && onSessionEnded) onSessionEnded(err);
        throw err;
      }
      return data;
    };
  };

  // Shows "sample data" ribbon when the server says the catalogue is sample data.
  fetch('/config.json').then((r) => r.json()).then((c) => {
    if (!c.sample_notice || document.getElementById('sampleNotice')) return;
    const bar = document.createElement('div');
    bar.id = 'sampleNotice';
    bar.textContent = 'Pilot preview: centres, machines and rates shown are sample data and may not be accurate.';
    bar.style.cssText = 'background:#FFF1E8;color:#7A2E0E;font:12px/1.4 Inter,system-ui,sans-serif;text-align:center;padding:6px 12px;border-bottom:1px solid #FFD9C2';
    document.body.prepend(bar);
  }).catch(() => {});
})();
