// GET /api/order?session_id=cs_...  → used by delivery.html to show the link
import { json, getOrder, fulfill, stripe, orderRef, formatMoney } from '../../lib/store.js';

export async function onRequestGet({ request, env, waitUntil }) {
  const sid = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]{10,}$/.test(sid)) return json({ status: 'invalid' }, 400);

  let order = await getOrder(env, sid);
  if (!order) {
    // Webhook not here yet: ask Stripe directly, and deliver if paid.
    try {
      const session = await stripe(env, 'GET', '/v1/checkout/sessions/' + encodeURIComponent(sid));
      order = await fulfill(env, session, { waitUntil });
    } catch (e) {
      return json({ status: 'not_found' }, 404);
    }
  }

  const urls = order.urls || (order.url ? [order.url] : []);
  if (urls.length) {
    return json({
      status: order.status === 'delivered' ? 'delivered' : 'partial',   // partial = some links still to come
      url: urls[0], urls, email: maskEmail(order.email),
      ref: orderRef(sid), total: formatMoney(order.amount, order.currency), amount: order.amount || 0, currency: order.currency || 'usd', date: order.created_at || null,
    });
  }
  return json({ status: order.status, email: maskEmail(order.email) });
}

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}
