import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createApiKey, listApiKeys } from '../../../lib/auth';
import { logAudit } from '../../../lib/auth';

export const GET: APIRoute = async () => {
  const keys = await listApiKeys(env);
  return new Response(JSON.stringify({ api_keys: keys }), { headers: { 'content-type': 'application/json' } });
};
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const res = await createApiKey(env, body as any);
  if (!res.ok) return new Response(JSON.stringify({ error: res.error }), { status: 400, headers: { 'content-type': 'application/json' } });
  await logAudit(env, { actor: 'admin', action: 'api_key.create', target_type: 'api_key', target_id: res.apiKey.id });
  return new Response(JSON.stringify({ ...res.apiKey, plainKey: res.plainKey }), { status: 201, headers: { 'content-type': 'application/json' } });
};
