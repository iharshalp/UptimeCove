import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteApiKey } from '../../../../lib/auth';

export const POST: APIRoute = async ({ params }) => {
  const ok = await deleteApiKey(env, String(params.id));
  if (!ok) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(null, { status: 204 });
};
export const DELETE: APIRoute = async ({ params }) => {
  const ok = await deleteApiKey(env, String(params.id));
  if (!ok) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(null, { status: 204 });
};
