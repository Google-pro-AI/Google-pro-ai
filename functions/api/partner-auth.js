// POST /api/partner-auth {login, password}  → partner login with username (or email) + password
// Returns the partner's private key, which the dashboard keeps in the browser.
import { json, now, ensureSchema, verifyPassword } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  const b = await request.json().catch(() => ({}));
  const login = String(b.login || '').trim().toLowerCase(), pw = String(b.password || '');
  if (!login || !pw) return json({ error: 'Please enter your username and password.' }, 400);
  const p = await env.DB.prepare(`SELECT * FROM partners WHERE code = ?1 OR email = ?1 LIMIT 1`).bind(login).first();
  const bad = () => json({ error: 'Wrong username or password.' }, 401);
  if (!p) { await verifyPassword(pw, { pass_hash: '0', pass_salt: 'x' }); return bad(); }   // same timing either way
  if (p.login_locked_until && p.login_locked_until > now())
    return json({ error: 'Too many wrong attempts. Please wait 15 minutes, or use "Forgot password?".' }, 429);
  if (!p.pass_hash) return json({ error: 'No password set yet for this account. Use "Forgot password?" to receive your login link by email, then set a password.' }, 401);
  if (!(await verifyPassword(pw, p))) {
    const fails = (p.login_fails || 0) + 1;
    await env.DB.prepare(`UPDATE partners SET login_fails = ?1, login_locked_until = ?2 WHERE code = ?3`)
      .bind(fails >= 8 ? 0 : fails, fails >= 8 ? now() + 900 : null, p.code).run();
    return bad();
  }
  if (p.approved === -1) return json({ error: 'This partner account is closed. Contact support if you have questions.' }, 403);
  await env.DB.prepare(`UPDATE partners SET login_fails = 0, login_locked_until = NULL WHERE code = ?1`).bind(p.code).run();
  return json({ ok: true, code: p.code, key: p.secret });
}
