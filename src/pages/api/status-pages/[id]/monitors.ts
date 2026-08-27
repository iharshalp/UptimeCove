import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { setPageMonitors, getStatusPageMonitorIds, getStatusPageById } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const page = await getStatusPageById(env, id);
	if (!page) return json({ error: 'Not found' }, 404);
	const monitorIds = await getStatusPageMonitorIds(env, id);
	return json({ pageId: id, monitorIds });
};

export const PUT: APIRoute = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, 400);
	}

	let monitorIds: unknown;
	if (Array.isArray(body)) {
		monitorIds = body;
	} else if (body && typeof body === 'object') {
		const b = body as Record<string, unknown>;
		monitorIds = b.monitorIds ?? b.monitor_ids ?? b.ids ?? b.monitors ?? b.monitorIdsOrdered;
		// support { monitorIds: "1,2,3" } string
		if (typeof monitorIds === 'string') {
			monitorIds = (monitorIds as string)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}

	if (!Array.isArray(monitorIds)) return json({ error: 'monitorIds must be an array' }, 400);

	const ids = (monitorIds as unknown[]).map((v) => Number(v));
	for (const n of ids) if (!Number.isInteger(n) || n <= 0) return json({ error: `Invalid monitor id: ${n}` }, 400);

	const result = await setPageMonitors(env, id, ids);
	if (!result.ok) return json({ error: result.error }, 400);
	return json({ ok: true, pageId: id, monitorIds: ids });
};

export const POST: APIRoute = async (ctx) => {
	return PUT(ctx as never);
};
