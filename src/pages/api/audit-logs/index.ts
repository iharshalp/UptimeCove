import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listAuditLogs } from '../../../lib/auth';

export const GET: APIRoute = async ({ url }) => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
  const logs = await listAuditLogs(env, { limit });
  return new Response(JSON.stringify({ logs }), { headers: { 'content-type': 'application/json' } });
};
