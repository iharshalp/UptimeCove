import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveIncident } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const POST: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid incident id' }, 400);
	const result = await resolveIncident(env, id);
	if (!result.ok) {
		const status = result.error === 'Incident not found' ? 404 : 400;
		return json({ error: result.error }, status);
	}
	return json({ ok: true });
};
