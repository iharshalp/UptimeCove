import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSubscriber } from '../../../lib/platform';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as any;
  const res = await createSubscriber(env, Number(body.status_page_id ?? body.page_id ?? 1), String(body.email ?? ''));
  if (!res.ok) return new Response(JSON.stringify({ error: res.error }), { status: 400, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ id: res.id }), { status: 201, headers: { 'content-type': 'application/json' } });
};
export const GET: APIRoute = async ({ url }) => {
  const pageId = Number(url.searchParams.get('page_id') ?? 1);
  const res = await env.DB.prepare(`SELECT id, email, verified, created_at FROM subscribers WHERE status_page_id = ? ORDER BY created_at DESC LIMIT 100`).bind(pageId).all();
  return new Response(JSON.stringify({ subscribers: res.results ?? [] }), { headers: { 'content-type': 'application/json' } });
};
