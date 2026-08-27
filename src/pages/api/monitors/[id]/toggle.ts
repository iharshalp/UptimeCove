import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { toggleMonitor } from '../../../../lib/queries';

export const POST: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400, headers: { 'content-type': 'application/json' } });
	}
	if (!(await toggleMonitor(env, id))) {
		return new Response(JSON.stringify({ error: 'Monitor not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
	}
	return new Response(null, { status: 204 });
};
