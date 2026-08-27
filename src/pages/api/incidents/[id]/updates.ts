import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { addIncidentUpdate } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const POST: APIRoute = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid incident id' }, 400);

	let body: { message?: string; author?: string } = {};
	const ct = request.headers.get('content-type') ?? '';
	try {
		if (ct.includes('application/json')) {
			body = (await request.json()) as typeof body;
		} else {
			const form = await request.formData();
			body = { message: String(form.get('message') ?? ''), author: String(form.get('author') ?? '') };
		}
	} catch {
		return json({ error: 'Invalid body' }, 400);
	}

	const message = typeof body.message === 'string' ? body.message : '';
	const author = typeof body.author === 'string' ? body.author : null;

	const result = await addIncidentUpdate(env, id, message, author);
	if (!result.ok) {
		const status = result.error === 'Incident not found' ? 404 : 400;
		return json({ error: result.error }, status);
	}
	return json({ update: result.update }, 201);
};
