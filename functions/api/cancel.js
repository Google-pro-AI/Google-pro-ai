// POST /api/cancel {r}  ← called when a customer clicks "Back" on the Stripe page.
// Closes that Stripe payment page and puts the link back in stock immediately.
import { json, stripe, releaseReservation } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const r = String(body.r || '');
  if (!/^[a-f0-9]{32}$/.test(r)) return json({ released: false }, 400);

  const link = await env.DB.prepare(
    `SELECT session_id FROM links WHERE reservation = ?1 AND status = 'reserved'`
  ).bind(r).first();
  if (!link) return json({ released: false });          // already sold or already back in stock

  if (link.session_id) {
    try {
      // close the payment page so it can no longer be paid
      await stripe(env, 'POST', '/v1/checkout/sessions/' + encodeURIComponent(link.session_id) + '/expire');
    } catch (e) {
      // could not close it (e.g. the customer just paid) → keep the link reserved for them
      return json({ released: false });
    }
  }
  await releaseReservation(env, r);
  return json({ released: true });
}
