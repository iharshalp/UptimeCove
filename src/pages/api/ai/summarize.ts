import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { summarizeIncidents } from '../../../lib/ai';
export const GET: APIRoute = async ({ url }) => {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
  const since = Math.floor(Date.now()/1000) - days*86400;
  const incidents = await env.DB.prepare(`SELECT cause, started_at, resolved_at FROM incidents WHERE started_at >= ? ORDER BY started_at DESC LIMIT 50`).bind(since).all().then(r=> (r.results as any[]) ?? []);
  const summary = await summarizeIncidents(env, incidents);
  return new Response(JSON.stringify({ summary, count: incidents.length }), { headers: { 'content-type': 'application/json' } });
};
