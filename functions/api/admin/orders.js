// GET  /api/admin/orders           → latest 200 orders
// POST /api/admin/orders {session_id, action:"resend"}  → re-send the delivery email
import { json, isAdmin, sendDeliveryEmail, getOrder } from '../../../lib/store.js';

export async function onRequest({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT o.session_id, o.email, o.name, o.amount, o.currency, o.status, o.emailed, o.created_at, l.url
       FROM orders o LEFT JOIN links l ON l.id = o.link_id ORDER BY o.created_at DESC LIMIT 200`
    ).all();
    return json({ orders: rows.results });
  }

  if (request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (b.action === 'resend' && b.session_id) {
      await env.DB.prepare(`UPDATE orders SET emailed = 0 WHERE session_id = ?1`).bind(b.session_id).run();
      const o = await getOrder(env, b.session_id);
      if (!o || o.status !== 'delivered') return json({ error: 'order not delivered' }, 400);
      const sent = await sendDeliveryEmail(env, o);
      return json({ sent });
    }
    return json({ error: 'unknown action' }, 400);
  }
  return json({ error: 'method not allowed' }, 405);
}
