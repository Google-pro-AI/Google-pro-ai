// POST /api/checkout  → holds one link and returns a Stripe Checkout URL
import { json, now, randomToken, siteUrl, settings, reserveLink, releaseReservation, activeHoldsForIp, stripe } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.STRIPE_SECRET_KEY) return json({ error: 'Store is not configured yet.' }, 503);
  const s = settings(env);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  // stop one visitor from holding the whole stock with unpaid checkouts
  if (await activeHoldsForIp(env, ip) >= s.maxHoldsPerIp) {
    return json({ error: 'Too many open checkouts. Please finish your payment or wait 30 minutes.' }, 429);
  }

  const reservation = randomToken(16);
  const expiresAt = now() + s.holdMinutes * 60 + 60;         // Stripe needs ≥ 30 min
  const held = await reserveLink(env, reservation, expiresAt + 300, ip); // hold 5 min longer than the session
  if (!held) return json({ error: 'sold_out' }, 409);

  const base = siteUrl(env, request);
  const lineItem = s.priceId
    ? { price: s.priceId, quantity: 1 }
    : { price_data: { currency: s.currency, unit_amount: s.amount, product_data: { name: s.productName } }, quantity: 1 };

  try {
    const session = await stripe(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment',
      line_items: { 0: lineItem },
      success_url: `${base}/delivery.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?checkout=cancelled`,
      expires_at: expiresAt,
      client_reference_id: reservation,
      metadata: { reservation },
      payment_intent_data: { metadata: { reservation } },
    });
    return json({ url: session.url });
  } catch (e) {
    await releaseReservation(env, reservation);
    console.log('Stripe checkout error:', e.message);
    return json({ error: 'Payment page could not be created. ' + e.message }, 502);
  }
}
