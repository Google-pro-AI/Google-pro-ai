// Partner's own dashboard API (no customer details).
// GET  /api/partner?code=sara&key=...           → profile, balances, payout periods
// POST /api/partner {code, key, payout_method, payout_details, messenger, contact}  → update own details
import { json, normCode, safeEqual, ensureSchema, partnerLedger, publicLedger, checkPayout, checkContact, checkPassword, hashPassword } from '../../lib/store.js';

async function load(env, code, key) {
  if (!code || !key) return null;
  await ensureSchema(env);
  const p = await env.DB.prepare(`SELECT * FROM partners WHERE code = ?1`).bind(code).first();
  return p && safeEqual(key, p.secret) ? p : null;
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const p = await load(env, normCode(u.searchParams.get('code')), u.searchParams.get('key') || '');
  if (!p) return json({ error: 'not_found' }, 404);
  const L = publicLedger(await partnerLedger(env, p.code));
  return json({
    partner: { code: p.code, name: p.name, pct: p.pct, active: !!p.active, approved: p.approved, clicks: p.clicks,
      email: p.email, whatsapp: p.whatsapp, messenger: p.messenger || 'whatsapp', verified: p.approved === 1, has_password: !!p.pass_hash, country: p.country, payout_method: p.payout_method, payout_details: p.payout_details },
    ...L,
    support: { email: env.SUPPORT_EMAIL || 'support@aipropass.online', whatsapp: env.WHATSAPP_NUMBER || '447378106036', whatsapp_label: env.WHATSAPP_LABEL || '+44 7378 106036' },
  });
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const p = await load(env, normCode(b.code), String(b.key || ''));
  if (!p) return json({ error: 'not_found' }, 404);
  if (b.new_password != null) {                        // change / set password (dashboard is already logged in)
    const e = checkPassword(b.new_password); if (e) return json({ error: e }, 400);
    const h = await hashPassword(b.new_password);
    await env.DB.prepare(`UPDATE partners SET pass_hash = ?1, pass_salt = ?2, login_fails = 0, login_locked_until = NULL WHERE code = ?3`).bind(h.hash, h.salt, p.code).run();
    return json({ ok: true });
  }
  const clip = (v, n, d) => v == null ? d : String(v).trim().slice(0, n);
  const method = b.payout_method == null ? p.payout_method : String(b.payout_method);
  const details = clip(b.payout_details, 200, p.payout_details);
  const messenger = b.messenger == null ? (p.messenger || 'whatsapp') : String(b.messenger);
  const contact = clip(b.contact ?? b.whatsapp, 40, p.whatsapp);
  const e1 = checkPayout(method, details); if (e1) return json({ error: e1 }, 400);
  const e2 = checkContact(messenger, contact); if (e2) return json({ error: e2 }, 400);
  await env.DB.prepare(`UPDATE partners SET payout_method = ?1, payout_details = ?2, whatsapp = ?3, messenger = ?4 WHERE code = ?5`)
    .bind(method, details, contact, messenger, p.code).run();
  return json({ ok: true });
}
