import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStatusPageById, updateStatusPage, deleteStatusPage, getStatusPageMonitorIds } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const page = await getStatusPageById(env, id);
	if (!page) return json({ error: 'Not found' }, 404);
	const monitorIds = await getStatusPageMonitorIds(env, id);
	return json({ page: { ...page, monitorIds } });
};

export const PUT: APIRoute = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'Invalid JSON' }, 400);
	}

	const result = await updateStatusPage(env, id, {
		slug: body.slug as string | undefined,
		title: body.title as string | undefined,
		description: body.description as string | undefined,
		branding_logo_url: (body.branding_logo_url as string | undefined) ?? (body.logo_url as string | undefined),
		branding_theme: (body.branding_theme as string | undefined) ?? (body.theme as string | undefined),
		custom_domain: body.custom_domain as string | undefined,
		is_public: body.is_public as string | number | boolean | null | undefined,
	});
	if (!result.ok) return json({ error: result.error }, 400);
	return json({ page: result.page });
};

export const DELETE: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const result = await deleteStatusPage(env, id);
	if (!result.ok) return json({ error: result.error }, 400);
	return new Response(null, { status: 204 });
};

export const POST: APIRoute = async (ctx) => {
	// allow POST as alias for PUT for form submissions
	return PUT(ctx as never);
};
