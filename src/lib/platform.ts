// Re-export auth helpers for convenience; keep subscriber/RSS/badge here
export * from './auth';

import type { StatusPage } from '../types';

export async function createSubscriber(env: Env, statusPageId: number, email: string) {
  const clean = email.trim().toLowerCase().slice(0, 254);
  if (!clean || !clean.includes('@')) return { ok: false as const, error: 'Valid email is required' };
  const page = await env.DB.prepare(`SELECT id FROM status_pages WHERE id = ?`).bind(statusPageId).first();
  if (!page) return { ok: false as const, error: 'Status page not found' };
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, created_at) VALUES (?, ?, ?, 0, ?)`).bind(id, statusPageId, clean, Math.floor(Date.now()/1000)).run();
    return { ok: true as const, id };
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) return { ok: false as const, error: 'Already subscribed' };
    throw e;
  }
}
export function buildRssFeed(page: { title: string; slug: string }, incidents: Array<{ id: number; cause: string; started_at: number; resolved_at: number | null }>, baseUrl: string): string {
  const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const items = incidents.map((inc) => `  <item>
    <title>${esc(inc.cause.slice(0, 120))}</title>
    <guid>${baseUrl}/incidents/${inc.id}</guid>
    <pubDate>${new Date(inc.started_at * 1000).toUTCString()}</pubDate>
    <description>${esc(inc.resolved_at ? `Resolved after ${Math.round((inc.resolved_at - inc.started_at)/60)}m` : 'Ongoing')}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>${esc(page.title)}</title>\n  <link>${baseUrl}/status/${page.slug}</link>\n  <description>Status updates for ${esc(page.title)}</description>\n${items}\n</channel></rss>`;
}
export function buildBadgeSvg(label: string, value: string, color: string): string {
  const w1 = label.length * 6.5 + 20;
  const w2 = value.length * 6.5 + 20;
  const w = w1 + w2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><rect rx="3" width="${w}" height="20" fill="#555"/><rect rx="3" x="${w1}" width="${w2}" height="20" fill="${color}"/><rect rx="3" width="${w}" height="20" fill="url(#s)"/><g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11"><text x="${w1/2}" y="14">${label}</text><text x="${w1 + w2/2}" y="14">${value}</text></g></svg>`;
}
