// Admin API — needs header  Authorization: Bearer <ADMIN_TOKEN>
// GET  /api/admin/links            → stock summary + latest links
// POST /api/admin/links {links:"one per line"}  → add new links (duplicates skipped)
// DELETE /api/admin/links?id=12    → disable an unsold link
import { json, isAdmin, now } from '../../../lib/store.js';

export async function onRequest({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const t = now();
    const s = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status='available' OR (status='reserved' AND reserved_until < ?1) THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN status='reserved' AND reserved_until >= ?1 THEN 1 ELSE 0 END) AS in_checkout,
        SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold,
        SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled
      FROM links`).bind(t).first();
    const filter = url.searchParams.get('status');
    const rows = await env.DB.prepare(
      `SELECT id, url, status, session_id, sold_at, created_at FROM links
       ${filter ? 'WHERE status = ?1' : ''} ORDER BY id DESC LIMIT 200`
    ).bind(...(filter ? [filter] : [])).all();
    return json({ summary: s, links: rows.results });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const list = String(body.links || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const valid = list.filter(x => /^https?:\/\/\S+$/i.test(x));
    if (!valid.length) return json({ error: 'No valid links (each line must start with http:// or https://).' }, 400);
    const stmts = valid.map(u => env.DB.prepare(`INSERT OR IGNORE INTO links (url) VALUES (?1)`).bind(u));
    const res = await env.DB.batch(stmts);
    const added = res.reduce((n, r) => n + (r.meta && r.meta.changes ? r.meta.changes : 0), 0);
    return json({ added, duplicates: valid.length - added, invalid: list.length - valid.length });
  }

  if (request.method === 'DELETE') {
    const id = parseInt(url.searchParams.get('id') || '', 10);
    const r = await env.DB.prepare(
      `UPDATE links SET status='disabled' WHERE id = ?1 AND (status='available' OR (status='reserved' AND reserved_until < ?2))`
    ).bind(id, now()).run();
    return json({ disabled: r.meta.changes });
  }

  return json({ error: 'method not allowed' }, 405);
}
