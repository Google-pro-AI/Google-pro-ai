// Admin API for partners — needs  Authorization: Bearer <ADMIN_TOKEN>
// GET                                           → all partners with balances and details
// POST {name, code, pct, email, whatsapp, ...}  → add a partner yourself (approved)
// POST {action:"approve"|"reject", code}        → activate manually (if their confirmation email never arrived) / block
// POST {action:"update", code, pct?, active?}   → change % or pause/resume
// POST {action:"payout", code}                  → mark everything "ready to pay" as paid
import { json, isAdmin, normCode, randomToken, ensureSchema, defaultPct, partnerLedger, settlePartner, partnerLinks, sendPartnerEmail, esc } from '../../../lib/store.js';

export async function onRequest({ request, env, waitUntil }) {
  if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env);

  if (request.method === 'GET') {
    const ps = (await env.DB.prepare(`SELECT * FROM partners ORDER BY approved ASC, created_at DESC`).all()).results || [];
    const out = [];
    for (const p of ps) {
      const L = await partnerLedger(env, p.code);
      out.push({ ...p, ...L.totals, links: partnerLinks(env, request, p) });
    }
    return json({ partners: out, default_pct: defaultPct(env) });
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const b = await request.json().catch(() => ({}));
  const code = normCode(b.code);

  if (b.action === 'payout') return json(await settlePartner(env, code));

  if (b.action === 'approve' || b.action === 'reject') {
    const p = await env.DB.prepare(`SELECT * FROM partners WHERE code = ?1`).bind(code).first();
    if (!p) return json({ error: 'not found' }, 404);
    if (b.action === 'reject') {
      await env.DB.prepare(`UPDATE partners SET approved = -1, active = 0 WHERE code = ?1`).bind(code).run();
      return json({ ok: true });
    }
    await env.DB.prepare(`UPDATE partners SET approved = 1, active = 1, verify_token = NULL WHERE code = ?1`).bind(code).run();
    if (p.email) {
      const L = partnerLinks(env, request, p);
      const m = sendPartnerEmail(env, p.email, '✅ You are approved — start earning with AI Pro Pass',
        `<h2 style="margin:0 0 10px;color:#111827">Welcome aboard, ${esc(p.name)}!</h2>
         <p>Your partner link is now active. You earn <b>${p.pct}%</b> of every order made through it.</p>
         <p><b>Your partner link:</b><br><a href="${esc(L.link)}" style="color:#5b5bf6">${esc(L.link)}</a></p>
         <p><b>Your dashboard:</b><br><a href="${esc(L.dashboard)}" style="color:#5b5bf6;word-break:break-all">${esc(L.dashboard)}</a></p>
         <p style="font-size:14px;color:#6b7280">Payouts: sales from the 1st–14th are paid on the 30th; sales from the 15th–end of month are paid on the 15th of the next month. Refunds are deducted automatically.</p>`);
      if (waitUntil) waitUntil(m); else await m;
    }
    return json({ ok: true });
  }

  if (b.action === 'update') {
    if (b.pct != null) await env.DB.prepare(`UPDATE partners SET pct = ?1 WHERE code = ?2`).bind(clampPct(b.pct), code).run();
    if (b.active != null) await env.DB.prepare(`UPDATE partners SET active = ?1 WHERE code = ?2 AND approved = 1`).bind(b.active ? 1 : 0, code).run();
    return json({ ok: true });
  }

  // add a partner yourself
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name || !code) return json({ error: 'Name and code are required. Code: 2–30 letters, numbers, - or _.' }, 400);
  const clip = (v, n) => String(v || '').trim().slice(0, n) || null;
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO partners (code, name, contact, pct, secret, active, approved, email, whatsapp, payout_method, payout_details)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?7, ?8, ?9)`
  ).bind(code, name, clip(b.contact, 120), clampPct(b.pct ?? defaultPct(env)), randomToken(12),
         clip(b.email, 120) && clip(b.email, 120).toLowerCase(), clip(b.whatsapp, 40), clip(b.payout_method, 20), clip(b.payout_details, 400)).run();
  if (r.meta.changes !== 1) return json({ error: 'This code (or email) is already used. Choose another one.' }, 409);
  return json({ ok: true, code });
}

function clampPct(v) { return Math.min(90, Math.max(0, parseInt(v, 10) || 0)); }
