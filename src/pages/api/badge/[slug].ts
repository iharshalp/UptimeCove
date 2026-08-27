import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStatusPage, getPageMonitors } from '../../../lib/queries';
import { buildBadgeSvg } from '../../../lib/platform';

export const GET: APIRoute = async ({ params, url }) => {
  const slug = String(params.slug ?? 'default');
  const page = await getStatusPage(env, slug);
  if (!page) return new Response('Not found', { status: 404 });
  const monitors = await getPageMonitors(env, (page as any).id);
  const style = url.searchParams.get('style') ?? 'flat';
  if (monitors.length === 0) {
    const svg = buildBadgeSvg('uptime', 'unknown', '#9f9f9f');
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=60' } });
  }
  const allUp = monitors.every((m: any) => m.current_status === 'up');
  const anyDown = monitors.some((m: any) => m.current_status === 'down');
  const value = anyDown ? 'down' : allUp ? 'up' : 'degraded';
  const color = anyDown ? '#e05d44' : allUp ? '#4c1' : '#dfb317';
  const svg = buildBadgeSvg('status', value, color);
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=60' } });
};
