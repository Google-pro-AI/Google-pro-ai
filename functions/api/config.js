// GET /api/config  → public settings for the browser (the Meta Pixel ID is public by design)
import { json } from '../../lib/store.js';
export function onRequestGet({ env }) {
  const id = String(env.META_PIXEL_ID || '').trim();
  return json({ pixel_id: /^\d{6,20}$/.test(id) ? id : null });
}
