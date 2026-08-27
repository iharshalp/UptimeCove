import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStatusPage } from '../../../../lib/queries';
import { buildRssFeed } from '../../../../lib/platform';

export const GET: APIRoute = async ({ params, request }) => {
  const slug = String(params.slug ?? 'default');
  const page = await getStatusPage(env, slug);
  if (!page) return new Response('Not found', { status: 404 });
  const incidents = await env.DB.prepare(`SELECT i.id, i.cause, i.started_at, i.resolved_at FROM incidents i JOIN status_page_monitors spm ON spm.monitor_id = i.monitor_id WHERE spm.page_id = ? ORDER BY i.started_at DESC LIMIT 50`).bind((page as any).id).all().then(r => (r.results as any[]) ?? []);
  const base = new URL(request.url).origin;
  const rss = buildRssFeed(page as any, incidents, base);
  return new Response(rss, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
};
