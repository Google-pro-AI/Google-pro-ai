// GET /api/stock  → { in_stock, stock }  (index.html uses this to switch to "sold out" mode)
import { json, stockCount } from '../../lib/store.js';

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ in_stock: false, stock: 0 });
  const n = await stockCount(env);
  return json({ in_stock: n > 0, stock: n });
}
