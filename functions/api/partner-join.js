// POST /api/partner-join  ← the "Become a partner" form
// The username becomes the partner link (?ref=username). Partners are created instantly
// and become active as soon as they confirm their email.
import { json, now, randomToken, ensureSchema, defaultPct, partnerLinks, sendVerifyEmail, checkPayout, checkContact,
         checkUsername, checkPassword, hashPassword } from '../../lib/store.js';

export async function onRequestPost({ request, env, waitUntil }) {
  await ensureSchema(env);
  const b = await request.json().catch(() => ({}));
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  if (b.website) return json({ ok: true });                                  // hidden field: bots fill it
  const name = clip(b.name, 80), email = clip(b.email, 120).toLowerCase(), username = clip(b.username, 40).toLowerCase(),
        messenger = b.messenger === 'telegram' ? 'telegram' : b.messenger === 'whatsapp' ? 'whatsapp' : '',
        contact = clip(b.contact, 40), method = String(b.payout_method || ''), details = clip(b.payout_details, 200);
  if (!name) return json({ error: 'Please enter your name.', field: 'name' }, 400);
  const eu = checkUsername(username); if (eu) return json({ error: eu, field: 'username' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return json({ error: 'Please enter a valid email address.', field: 'email' }, 400);
  const ep = checkPassword(b.password); if (ep) return json({ error: ep, field: 'password' }, 400);
  const e1 = checkContact(messenger, contact); if (e1) return json({ error: e1, field: 'contact' }, 400);
  const e2 = checkPayout(method, details); if (e2) return json({ error: e2, field: 'payout_details' }, 400);
  if (!b.agree) return json({ error: 'Please accept the partner terms.' }, 400);

  if (await env.DB.prepare(`SELECT 1 FROM partners WHERE email = ?1`).bind(email).first())
    return json({ error: 'This email is already registered. Please log in instead.', field: 'email' }, 409);
  if (await env.DB.prepare(`SELECT 1 FROM partners WHERE code = ?1`).bind(username).first())
    return json({ error: 'This username is already taken. Please choose another one.', field: 'username' }, 409);

  const pw = await hashPassword(b.password);
  const p = { code: username, name, email, secret: randomToken(12), verify_token: randomToken(16) };
  try {
    await env.DB.prepare(
      `INSERT INTO partners (code, name, contact, pct, secret, active, approved, email, whatsapp, messenger, payout_method, payout_details, verify_token, pass_hash, pass_salt, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(p.code, name, email, defaultPct(env), p.secret, email, contact, messenger, method, details, p.verify_token, pw.hash, pw.salt, now()).run();
  } catch (e) {                                                              // two sign-ups at the same moment
    return json({ error: 'This username or email is already taken.', field: 'username' }, 409);
  }

  const m = sendVerifyEmail(env, request, p);
  if (waitUntil) waitUntil(m); else await m;
  const L = partnerLinks(env, request, p);
  return json({ ok: true, code: p.code, key: p.secret, dashboard: L.dashboard, link: L.link, email });
}

// GET /api/partner-join?username=sara  → is this username free? (live check on the form)
export async function onRequestGet({ request, env }) {
  await ensureSchema(env);
  const u = String(new URL(request.url).searchParams.get('username') || '').trim().toLowerCase();
  const err = checkUsername(u);
  if (err) return json({ available: false, error: err });
  const taken = await env.DB.prepare(`SELECT 1 FROM partners WHERE code = ?1`).bind(u).first();
  return json({ available: !taken, error: taken ? 'This username is already taken.' : '' });
}
