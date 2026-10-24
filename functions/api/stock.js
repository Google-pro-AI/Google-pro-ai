// GET /api/stock  → stock + prices (index.html uses this for the quantity picker and "sold out" mode)
import { json, stockCount, settings } from '../../lib/store.js';

export async function onRequestGet({ env }) {
  const s = settings(env);
  if (!env.DB) return json({ in_stock: false, stock: 0 });
  const n = await stockCount(env);
  return json({
    in_stock: n > 0,
    stock: n,
    max_qty: Math.min(s.maxQty, n),
    currency: s.currency,
    tiers: s.tiers,          // [{min, unit}] unit = price per pass in cents
  });
}
