// POST /api/ref {code}  ← counts a visit from a partner link
import { json, normCode, ensureSchema } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const code = normCode(b.code);
  if (!code || !env.DB) return json({ ok: false });
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare(`UPDATE partners SET clicks = clicks + 1 WHERE code = ?1 AND active = 1 AND approved = 1`).bind(code).run();
    return json({ ok: r.meta.changes === 1 });
  } catch (e) { return json({ ok: false }); }
}
