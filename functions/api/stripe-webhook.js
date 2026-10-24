// POST /api/stripe-webhook  ← Stripe calls this after a payment
import { json, verifyStripeSignature, fulfill, releaseReservation, markRefunded } from '../../lib/store.js';

export async function onRequestPost({ request, env, waitUntil }) {
  const payload = await request.text();
  const ok = await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'bad signature' }, 400);

  const event = JSON.parse(payload);
  const session = event.data && event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await fulfill(env, session, { waitUntil });
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      await releaseReservation(env, session.metadata && session.metadata.reservation);
      break;
    case 'charge.refunded':
      await markRefunded(env, session);   // here the object is a Stripe charge
      break;
  }
  return json({ received: true });
}
