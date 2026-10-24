// Shared logic for the AI Pro Pass store (used by the files in /functions).
// Nothing here needs editing: settings come from Cloudflare environment variables.

export const now = () => Math.floor(Date.now() / 1000);

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function siteUrl(env, request) {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

// ---------- settings ----------
export function settings(env) {
  return {
    productName: env.PRODUCT_NAME || 'AI Pro Pass — 18 Months of Google AI Pro',
    amount: parseInt(env.PRICE_CENTS || '1999', 10),
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    priceId: env.STRIPE_PRICE_ID || '',
    holdMinutes: 30,               // Stripe's minimum checkout lifetime
    maxHoldsPerIp: parseInt(env.MAX_HOLDS_PER_IP || '3', 10),
    maxQty: Math.max(1, parseInt(env.MAX_QTY || '5', 10)),
    // Volume pricing "minQty:centsEach,…"  e.g. 1:1999,2:1799,3:1599
    tiers: parseTiers(env.PRICE_TIERS || `1:${env.PRICE_CENTS || '1999'},2:1799,3:1599`),
  };
}

function parseTiers(str) {
  const t = String(str).split(',').map(x => x.trim().split(':').map(n => parseInt(n, 10)))
    .filter(([q, c]) => q >= 1 && c > 0).map(([min, unit]) => ({ min, unit }))
    .sort((a, b) => a.min - b.min);
  if (!t.length || t[0].min !== 1) t.unshift({ min: 1, unit: 1999 });
  return t;
}

// price per pass for a given quantity
export function unitPrice(s, qty) {
  let u = s.tiers[0].unit;
  for (const t of s.tiers) if (qty >= t.min) u = t.unit;
  return u;
}

// ---------- stock ----------
// A link is "free" when it is available, or when its reservation has expired.
const FREE = `(status = 'available' OR (status = 'reserved' AND reserved_until < ?1))`;

export async function stockCount(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE ${FREE}`).bind(now()).first();
  return r ? r.n : 0;
}

// Atomically hold `qty` free links for one checkout (all or nothing). Returns true/false.
export async function reserveLinks(env, reservation, untilTs, ip, qty = 1) {
  const t = now();
  const r = await env.DB.prepare(
    `UPDATE links SET status = 'reserved', reservation = ?2, reserved_until = ?3, reserved_ip = ?4
     WHERE id IN (SELECT id FROM links WHERE ${FREE} ORDER BY id LIMIT ?5)
     RETURNING id`
  ).bind(t, reservation, untilTs, ip, qty).all();
  const got = (r.results || []).length;
  if (got < qty) { if (got) await releaseReservation(env, reservation); return false; }
  return true;
}
export const reserveLink = (env, reservation, untilTs, ip) => reserveLinks(env, reservation, untilTs, ip, 1);

export async function releaseReservation(env, reservation) {
  if (!reservation) return;
  await env.DB.prepare(
    `UPDATE links SET status = 'available', reservation = NULL, reserved_until = NULL, reserved_ip = NULL
     WHERE reservation = ?1 AND status = 'reserved'`
  ).bind(reservation).run();
}

export async function activeHoldsForIp(env, ip) {
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT reservation) AS n FROM links WHERE status = 'reserved' AND reserved_ip = ?1 AND reserved_until >= ?2`
  ).bind(ip, now()).first();
  return r ? r.n : 0;
}

// ---------- Stripe ----------
function stripeBase(env) { return (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''); }

function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

export async function stripe(env, method, path, params) {
  const res = await fetch(stripeBase(env) + path, {
    method,
    headers: {
      authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params ? formEncode(params) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Stripe error: ' + (data.error && data.error.message || res.status));
  return data;
}

// Verify the Stripe-Signature header (HMAC-SHA256 of "timestamp.payload").
export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(now() - parseInt(t, 10)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => safeEqual(s, expected));
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- fulfilment ----------
// Gives the paid number of links (metadata.qty, default 1) to a paid Checkout session. Safe to call many times
// (webhook + delivery page may both call it): the orders row acts as a lock.
export async function fulfill(env, session, ctx) {
  if (!session || session.payment_status !== 'paid') return { status: 'unpaid' };
  const sid = session.id;

  const existing = await getOrder(env, sid);
  if (existing) return existing;

  const email = (session.customer_details && session.customer_details.email) || session.customer_email || null;
  const name = (session.customer_details && session.customer_details.name) || null;

  // Claim the order. Only one caller can insert it.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (session_id, email, name, amount, currency, status) VALUES (?1, ?2, ?3, ?4, ?5, 'processing')`
  ).bind(sid, email, name, session.amount_total || null, session.currency || null).run();
  if (!claim.meta || claim.meta.changes !== 1) return (await getOrder(env, sid)) || { status: 'processing' };

  const reservation = session.metadata && session.metadata.reservation;
  const qty = Math.max(1, parseInt((session.metadata && session.metadata.qty) || '1', 10) || 1);
  let got = 0;
  if (reservation) {
    const r = await env.DB.prepare(
      `UPDATE links SET status = 'sold', session_id = ?1, sold_at = ?2, reserved_until = NULL
       WHERE reservation = ?3 AND status = 'reserved' RETURNING id`
    ).bind(sid, now(), reservation).all();
    got = (r.results || []).length;
  }
  if (got < qty) {
    // Reservation (partly) lost — should not happen. Take the next free links instead.
    const r = await env.DB.prepare(
      `UPDATE links SET status = 'sold', session_id = ?2, sold_at = ?1, reserved_until = NULL
       WHERE id IN (SELECT id FROM links WHERE ${FREE} ORDER BY id LIMIT ?3) RETURNING id`
    ).bind(now(), sid, qty - got).all();
    got += (r.results || []).length;
  }

  const first = await env.DB.prepare(`SELECT id FROM links WHERE session_id = ?1 AND status = 'sold' ORDER BY id LIMIT 1`).bind(sid).first();
  const complete = got >= qty;
  await env.DB.prepare(`UPDATE orders SET link_id = ?1, status = ?2 WHERE session_id = ?3`)
    .bind(first ? first.id : null, complete ? 'delivered' : 'needs_attention', sid).run();

  const tasks = [];
  if (!complete) {
    tasks.push(notifyAdmin(env, `⚠️ Paid order short of stock (${sid})`,
      `<p>A customer paid for <b>${qty}</b> pass(es) but only <b>${got}</b> link(s) were available.</p><p>Session: ${esc(sid)}<br>Email: ${esc(email || '-')}</p><p>Add links in the admin page, then send the missing ${qty - got} by hand, or refund them in Stripe.</p>`));
  }
  const order = await getOrder(env, sid);
  if (got > 0) tasks.push(sendDeliveryEmail(env, order));
  const all = Promise.all(tasks);
  if (ctx && ctx.waitUntil) ctx.waitUntil(all); else await all;
  return order;
}

export async function getOrder(env, sid) {
  const o = await env.DB.prepare(
    `SELECT session_id, status, email, name, amount, currency, created_at, link_id FROM orders WHERE session_id = ?1`
  ).bind(sid).first();
  if (!o) return null;
  const l = await env.DB.prepare(`SELECT url FROM links WHERE session_id = ?1 AND status = 'sold' ORDER BY id`).bind(sid).all();
  o.urls = (l.results || []).map(x => x.url);
  o.url = o.urls[0] || null;
  return o;
}

// ---------- email (Resend) ----------
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendEmail(env, to, subject, html, text) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) return false;
  try {
    const res = await fetch((env.RESEND_API_BASE || 'https://api.resend.com') + '/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text: text || undefined, reply_to: env.SUPPORT_EMAIL || undefined }),
    });
    return res.ok;
  } catch (e) { return false; }
}

export function orderRef(sid) {
  return 'AIP-' + String(sid || '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();
}

export function formatMoney(amount, currency) {
  if (amount == null) return '';
  const c = String(currency || 'usd').toUpperCase();
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(amount / 100); }
  catch (e) { return (amount / 100).toFixed(2) + ' ' + c; }
}

function formatDate(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export async function sendDeliveryEmail(env, order) {
  const urls = (order && order.urls && order.urls.length) ? order.urls : (order && order.url ? [order.url] : []);
  if (!order || !order.email || !urls.length) return false;
  const many = urls.length > 1;
  // lock so the email is sent only once
  const lock = await env.DB.prepare(`UPDATE orders SET emailed = 1 WHERE session_id = ?1 AND emailed = 0`).bind(order.session_id).run();
  if (!lock.meta || lock.meta.changes !== 1) return false;

  const brand = env.BRAND_NAME || 'AI Pro Pass';
  const site = (env.SITE_URL || 'https://aipropass.online').replace(/\/+$/, '');
  const support = env.SUPPORT_EMAIL || 'support@aipropass.online';
  const wa = env.WHATSAPP_NUMBER || '447378106036';
  const waLabel = env.WHATSAPP_LABEL || '+44 7378 106036';
  const first = order.name ? String(order.name).trim().split(/\s+/)[0] : '';
  const ref = orderRef(order.session_id);
  const total = formatMoney(order.amount, order.currency);
  const date = formatDate(order.created_at);
  const E = esc;
  const linkBlocks = urls.map((u, i) => `
  <tr><td style="padding:${i ? 18 : 24}px 32px 0">
    ${many ? `<p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#111827">Pass ${i + 1} of ${urls.length}</p>` : ''}
    <a href="${E(u)}" target="_blank" style="display:inline-block;background:#5b5bf6;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 28px;border-radius:10px">Activate ${many ? 'pass ' + (i + 1) : 'my pass'}</a>
    <p style="margin:10px 0 0;font-size:13px;line-height:1.5;color:#111827;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;word-break:break-all;font-family:Menlo,Consolas,monospace">${E(u)}</p>
  </td></tr>`).join('');

  const row = (k, v) => `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px">${k}</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600;text-align:right">${v}</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your activation pass</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="display:none;max-height:0;overflow:hidden">Your order ${E(ref)} is confirmed. Your personal activation link is inside.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
  <tr><td style="background:#0b0b16;padding:22px 32px">
    <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background:#6d5efc;color:#fff;font-size:15px;vertical-align:middle">&#10022;</span>
    <span style="color:#ffffff;font-size:17px;font-weight:700;vertical-align:middle;margin-left:8px">${E(brand)}</span>
  </td></tr>
  <tr><td style="padding:32px 32px 8px">
    <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#16a34a">Order confirmed</p>
    <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;color:#111827">Thank you${first ? ', ' + E(first) : ''}. Your ${many ? urls.length + ' passes are' : 'pass is'} ready.</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#374151">Your payment has been received. Below ${many ? 'are your ' + urls.length + ' personal activation links — one per account' : 'is your personal activation link'}. ${many ? 'They are' : 'It is'} reserved for you and ${many ? 'have' : 'has'} not been given to anyone else.</p>
    ${order.status === 'needs_attention' ? '<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#92400e;background:#fef3c7;border-radius:8px;padding:10px 12px">The rest of your order will be sent to you shortly by our team.</p>' : ''}
  </td></tr>${linkBlocks}
  <tr><td style="padding:10px 32px 0"><p style="margin:0;font-size:12px;color:#6b7280">If a button does not work, copy the link below it into your browser.</p></td></tr>
  <tr><td style="padding:26px 32px 0">
    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#111827">How to activate</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;line-height:1.55;color:#374151">
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">1.</td><td style="padding-bottom:6px">Sign in to the personal account you want to activate.</td></tr>
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">2.</td><td style="padding-bottom:6px">Open your activation link and follow the on-screen steps.</td></tr>
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">3.</td><td>Each link can be used once, on one account. Please keep ${many ? 'them' : 'it'} private until you use ${many ? 'them' : 'it'}.</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:8px 0">
      ${row('Order reference', E(ref))}${row('Date', E(date))}${many ? row('Passes', String(urls.length)) : ''}${total ? row('Total paid', E(total)) : ''}${row('Sent to', E(order.email))}
    </table>
  </td></tr>
  <tr><td style="padding:22px 32px 30px">
    <p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:#374151"><b>Need help?</b> Simply reply to this email, write to <a href="mailto:${E(support)}" style="color:#5b5bf6">${E(support)}</a> or message us on <a href="https://wa.me/${E(wa)}" style="color:#5b5bf6">WhatsApp ${E(waLabel)}</a>. Our team replies within 24 hours.</p>
    <p style="margin:0;font-size:13px;color:#6b7280">Your purchase is covered by our <a href="${E(site)}/refund.html" style="color:#6b7280">30-day money-back guarantee</a>.</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:18px 32px;border-top:1px solid #e5e7eb">
    <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">${E(brand)} · <a href="${E(site)}" style="color:#9ca3af">${E(site.replace(/^https?:\/\//, ''))}</a><br>You receive this email because you placed an order on our website. Please keep it for your records.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${brand} — Order confirmed`,
    '',
    `Thank you${first ? ', ' + first : ''}. Your payment has been received.`,
    '',
    many ? `Your ${urls.length} personal activation links (one per account):` : 'Your personal activation link:',
    ...urls.map((u, i) => (many ? `Pass ${i + 1}: ` : '') + u),
    '',
    'How to activate:',
    '1. Sign in to the personal account you want to activate.',
    '2. Open the link above and follow the on-screen steps.',
    '3. Each link can be used once, on one account. Keep it private until you use it.',
    '',
    `Order reference: ${ref}`,
    `Date: ${date}`,
    total ? `Total paid: ${total}` : '',
    '',
    `Need help? Reply to this email, write to ${support} or WhatsApp ${waLabel}.`,
    `30-day money-back guarantee: ${site}/refund.html`,
  ].filter(l => l !== null).join('\n');

  return sendEmail(env, order.email, `Your activation link${many ? 's' : ''} — order ${ref}`, html, text);
}

export function notifyAdmin(env, subject, html) {
  return sendEmail(env, env.ADMIN_EMAIL, subject, html);
}

// ---------- admin auth ----------
export function isAdmin(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && safeEqual(token, env.ADMIN_TOKEN);
}
