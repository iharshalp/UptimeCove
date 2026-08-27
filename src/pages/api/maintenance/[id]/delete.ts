import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteMaintenanceWindow } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const POST: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const ok = await deleteMaintenanceWindow(env, id);
	if (!ok) return json({ error: 'Maintenance window not found' }, 404);
	return new Response(null, { status: 204 });
};

// Also allow DELETE verb for programmatic use
export const DELETE: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const ok = await deleteMaintenanceWindow(env, id);
	if (!ok) return json({ error: 'Maintenance window not found' }, 404);
	return new Response(null, { status: 204 });
};
