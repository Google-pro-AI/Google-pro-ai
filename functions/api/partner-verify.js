// GET  /api/partner-verify?code=..&t=..   ← link in the confirmation email → activates the partner
// POST /api/partner-verify {code, key}     ← "resend confirmation email" button on the dashboard
import { json, normCode, safeEqual, randomToken, ensureSchema, partnerLinks, sendVerifyEmail, sendEmail, esc } from '../../lib/store.js';

export async function onRequestGet({ request, env, waitUntil }) {
  await ensureSchema(env);
  const u = new URL(request.url), code = normCode(u.searchParams.get('code')), t = u.searchParams.get('t') || '';
  const p = code ? await env.DB.prepare(`SELECT * FROM partners WHERE code = ?1`).bind(code).first() : null;
  if (!p) return Response.redirect(new URL('/partner-join.html?verify=invalid', request.url).toString(), 302);
  const dash = partnerLinks(env, request, p).dashboard;
  if (p.approved === 1) return Response.redirect(dash + '&verified=1', 302);           // already confirmed
  if (p.approved === -1 || !p.verify_token || !safeEqual(t, p.verify_token))
    return Response.redirect(dash + '&verify=invalid', 302);
  await env.DB.prepare(`UPDATE partners SET approved = 1, active = 1, verify_token = NULL WHERE code = ?1 AND approved = 0`).bind(code).run();
  const m = sendEmail(env, env.ADMIN_EMAIL, `🤝 New partner: ${p.name}`,
    `<p><b>${esc(p.name)}</b> (${esc(p.email)}, ${esc(p.messenger === 'telegram' ? 'Telegram' : 'WhatsApp')} ${esc(p.whatsapp)}) confirmed their email and is now an active partner.</p>
     <p>Payout: ${esc(p.payout_method)} — ${esc(p.payout_details)}</p><p>You can pause them anytime in your admin page → Partners.</p>`);
  if (waitUntil) waitUntil(m); else await m;
  return Response.redirect(dash + '&verified=1', 302);
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  const b = await request.json().catch(() => ({}));
  const code = normCode(b.code);
  const p = code ? await env.DB.prepare(`SELECT * FROM partners WHERE code = ?1`).bind(code).first() : null;
  if (!p || !safeEqual(String(b.key || ''), p.secret)) return json({ error: 'not_found' }, 404);
  if (p.approved !== 0) return json({ ok: true, already: true });
  if (!p.verify_token) {
    p.verify_token = randomToken(16);
    await env.DB.prepare(`UPDATE partners SET verify_token = ?1 WHERE code = ?2`).bind(p.verify_token, code).run();
  }
  await sendVerifyEmail(env, request, p);
  return json({ ok: true, sent: true });
}
