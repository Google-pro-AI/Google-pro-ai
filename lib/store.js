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
  };
}

// ---------- stock ----------
// A link is "free" when it is available, or when its reservation has expired.
const FREE = `(status = 'available' OR (status = 'reserved' AND reserved_until < ?1))`;

export async function stockCount(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE ${FREE}`).bind(now()).first();
  return r ? r.n : 0;
}

// Atomically hold one free link for a checkout. Returns {id} or null if sold out.
export async function reserveLink(env, reservation, untilTs, ip) {
  const t = now();
  return env.DB.prepare(
    `UPDATE links SET status = 'reserved', reservation = ?2, reserved_until = ?3, reserved_ip = ?4
     WHERE id = (SELECT id FROM links WHERE ${FREE} ORDER BY id LIMIT 1)
     RETURNING id`
  ).bind(t, reservation, untilTs, ip).first();
}

export async function releaseReservation(env, reservation) {
  if (!reservation) return;
  await env.DB.prepare(
    `UPDATE links SET status = 'available', reservation = NULL, reserved_until = NULL, reserved_ip = NULL
     WHERE reservation = ?1 AND status = 'reserved'`
  ).bind(reservation).run();
}

export async function activeHoldsForIp(env, ip) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM links WHERE status = 'reserved' AND reserved_ip = ?1 AND reserved_until >= ?2`
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
// Gives exactly one link to a paid Checkout session. Safe to call many times
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
  let link = null;
  if (reservation) {
    link = await env.DB.prepare(
      `UPDATE links SET status = 'sold', session_id = ?1, sold_at = ?2, reserved_until = NULL
       WHERE reservation = ?3 AND status = 'reserved' RETURNING id, url`
    ).bind(sid, now(), reservation).first();
  }
  if (!link) {
    // Reservation was lost (should not happen). Take the next free link instead.
    link = await env.DB.prepare(
      `UPDATE links SET status = 'sold', session_id = ?2, sold_at = ?1, reserved_until = NULL
       WHERE id = (SELECT id FROM links WHERE ${FREE} ORDER BY id LIMIT 1) RETURNING id, url`
    ).bind(now(), sid).first();
  }

  if (!link) {
    await env.DB.prepare(`UPDATE orders SET status = 'needs_attention' WHERE session_id = ?1`).bind(sid).run();
    const task = notifyAdmin(env, `⚠️ Paid order without stock (${sid})`,
      `<p>A customer paid but no link was left.</p><p>Session: ${esc(sid)}<br>Email: ${esc(email || '-')}</p><p>Add links in the admin page, then deliver it by hand or refund it in Stripe.</p>`);
    if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
    return { status: 'needs_attention', email };
  }

  await env.DB.prepare(`UPDATE orders SET link_id = ?1, status = 'delivered' WHERE session_id = ?2`).bind(link.id, sid).run();
  const order = await getOrder(env, sid);

  const task = sendDeliveryEmail(env, order);
  if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
  return order;
}

export async function getOrder(env, sid) {
  const o = await env.DB.prepare(
    `SELECT o.session_id, o.status, o.email, o.name, o.amount, o.currency, o.created_at, o.link_id, l.url
     FROM orders o LEFT JOIN links l ON l.id = o.link_id WHERE o.session_id = ?1`
  ).bind(sid).first();
  return o || null;
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
  if (!order || !order.email || !order.url) return false;
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
  const url = order.url;
  const E = esc;

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
    <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;color:#111827">Thank you${first ? ', ' + E(first) : ''}. Your pass is ready.</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#374151">Your payment has been received. Below is your personal activation link. It is reserved for you and has not been given to anyone else.</p>
  </td></tr>
  <tr><td style="padding:24px 32px 6px" align="center">
    <a href="${E(url)}" target="_blank" style="display:inline-block;background:#5b5bf6;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:15px 34px;border-radius:10px">Activate my pass</a>
  </td></tr>
  <tr><td style="padding:12px 32px 0">
    <p style="margin:0 0 6px;font-size:12px;color:#6b7280;text-align:center">If the button does not work, copy this link into your browser:</p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#111827;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;word-break:break-all;font-family:Menlo,Consolas,monospace">${E(url)}</p>
  </td></tr>
  <tr><td style="padding:26px 32px 0">
    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#111827">How to activate</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;line-height:1.55;color:#374151">
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">1.</td><td style="padding-bottom:6px">Sign in to the personal account you want to activate.</td></tr>
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">2.</td><td style="padding-bottom:6px">Open your activation link and follow the on-screen steps.</td></tr>
      <tr><td valign="top" style="width:26px;font-weight:700;color:#5b5bf6">3.</td><td>The link can be used once, on one account. Please keep it private until you use it.</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:8px 0">
      ${row('Order reference', E(ref))}${row('Date', E(date))}${total ? row('Total paid', E(total)) : ''}${row('Sent to', E(order.email))}
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
    'Your personal activation link:',
    url,
    '',
    'How to activate:',
    '1. Sign in to the personal account you want to activate.',
    '2. Open the link above and follow the on-screen steps.',
    '3. The link can be used once, on one account. Keep it private until you use it.',
    '',
    `Order reference: ${ref}`,
    `Date: ${date}`,
    total ? `Total paid: ${total}` : '',
    '',
    `Need help? Reply to this email, write to ${support} or WhatsApp ${waLabel}.`,
    `30-day money-back guarantee: ${site}/refund.html`,
  ].filter(l => l !== null).join('\n');

  return sendEmail(env, order.email, `Your activation link — order ${ref}`, html, text);
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
