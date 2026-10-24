/* AI Pro Pass — Meta Pixel with a cookie consent banner.
   Nothing to edit here: the Pixel ID comes from the Cloudflare setting META_PIXEL_ID.
   The pixel only loads after the visitor clicks "Accept". */
(function () {
  var KEY = 'aip_consent', queue = [], state = null, pixelId = null, loaded = false;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function cookie(n) { var m = document.cookie.match('(?:^|; )' + n + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }

  // remember the ad click id (fbclid) from the landing URL, so a purchase can be matched to the ad
  try {
    var fbclid = new URLSearchParams(location.search).get('fbclid');
    if (fbclid) set('aip_fbc', 'fb.1.' + Date.now() + '.' + fbclid);
  } catch (e) {}

  function load() {
    if (loaded || !pixelId) return; loaded = true;
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
    queue.forEach(function (q) { send(q[0], q[1], q[2]); }); queue = [];
  }
  function send(name, params, eventID) { window.fbq('track', name, params || {}, eventID ? { eventID: eventID } : undefined); }

  function banner() {
    if (document.getElementById('aipCookie')) return;
    var css = document.createElement('style');
    css.textContent = '#aipCookie{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;background:#11111f;color:#eef0ff;border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:14px 16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center;flex-wrap:wrap}' +
      '#aipCookie p{flex:1 1 260px;margin:0;color:#c9cbe3}#aipCookie a{color:#a5b4fc}#aipCookie .b{display:flex;gap:8px;flex:none}' +
      '#aipCookie button{border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer}' +
      '#aipCookie .y{background:linear-gradient(135deg,#8b5cf6,#3b82f6 50%,#22d3ee);color:#fff}#aipCookie .n{background:rgba(255,255,255,.08);color:#eef0ff}';
    document.head.appendChild(css);
    var d = document.createElement('div'); d.id = 'aipCookie'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Cookie choice');
    d.innerHTML = '<p>We use cookies to measure our ads and improve the site. <a href="/privacy#s7">Learn more</a></p><div class="b"><button class="n" type="button">Decline</button><button class="y" type="button">Accept</button></div>';
    document.body.appendChild(d);
    d.querySelector('.y').onclick = function () { choose('yes'); };
    d.querySelector('.n').onclick = function () { choose('no'); };
  }
  function choose(v) {
    state = v; set(KEY, v);
    var d = document.getElementById('aipCookie'); if (d) d.remove();
    if (v === 'yes') load(); else queue = [];
  }

  window.AIP = {
    // track('Purchase', {value: 19.99, currency: 'USD'}, 'cs_...')
    track: function (name, params, eventID) {
      if (state === 'yes' && loaded) send(name, params, eventID);
      else if (state !== 'no') queue.push([name, params, eventID]);
    },
    // details sent with the checkout, so the server can report the purchase to Meta too (only with consent)
    info: function () {
      return state === 'yes' ? { consent: true, fbp: cookie('_fbp') || '', fbc: cookie('_fbc') || get('aip_fbc') || '' } : { consent: false };
    },
    reset: function () { set(KEY, ''); state = null; banner(); },
  };

  fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (c) {
    pixelId = c && c.pixel_id; if (!pixelId) return;            // pixel not set up yet → no banner
    state = get(KEY) || null;
    if (state === 'yes') load();
    else if (state !== 'no') { if (document.body) banner(); else document.addEventListener('DOMContentLoaded', banner); }
  }).catch(function () {});
})();
