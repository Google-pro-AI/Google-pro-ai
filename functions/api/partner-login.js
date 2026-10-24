// POST /api/partner-login {email}  → emails the partner their dashboard link again
import { json, ensureSchema, partnerLinks, sendPartnerEmail, sendVerifyEmail, randomToken, esc } from '../../lib/store.js';

export async function onRequestPost({ request, env, waitUntil }) {
  await ensureSchema(env);
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  const p = email ? await env.DB.prepare(`SELECT code, secret, name, email, approved, verify_token FROM partners WHERE email = ?1`).bind(email).first() : null;
  if (p && p.approved === 0) {                       // never confirmed → send the confirmation email again
    if (!p.verify_token) { p.verify_token = randomToken(16); await env.DB.prepare(`UPDATE partners SET verify_token = ?1 WHERE code = ?2`).bind(p.verify_token, p.code).run(); }
    const m = sendVerifyEmail(env, request, p);
    if (waitUntil) waitUntil(m); else await m;
  } else if (p) {
    const L = partnerLinks(env, request, p);
    const m = sendPartnerEmail(env, email, 'Your AI Pro Pass partner login link',
      `<p>Hi ${esc(p.name)}, you asked for a new login. Open your dashboard with this private link, then set a new password under <b>Login &amp; password</b>:</p><p><a href="${esc(L.dashboard)}" style="color:#5b5bf6;word-break:break-all">${esc(L.dashboard)}</a></p><p>Your username: <b>${esc(p.code)}</b><br>Your partner link: <a href="${esc(L.link)}" style="color:#5b5bf6">${esc(L.link)}</a></p>`);
    if (waitUntil) waitUntil(m); else await m;
  }
  return json({ ok: true });   // same answer either way (does not reveal who is registered)
}
