import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listStatusPages, createStatusPage } from '../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async () => {
	const pages = await listStatusPages(env);
	return json({ pages });
};

export const POST: APIRoute = async ({ request }) => {
	let body: Record<string, unknown> = {};
	const ctype = request.headers.get('content-type') ?? '';
	try {
		if (ctype.includes('application/json')) {
			body = (await request.json()) as Record<string, unknown>;
		} else if (ctype.includes('application/x-www-form-urlencoded') || ctype.includes('multipart/form-data')) {
			const form = await request.formData();
			for (const [k, v] of form.entries()) body[k] = String(v);
		} else {
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
		}
	} catch {
		return json({ error: 'Invalid body' }, 400);
	}

	const result = await createStatusPage(env, {
		slug: body.slug as string | undefined,
		title: body.title as string | undefined,
		description: body.description as string | undefined,
		branding_logo_url: (body.branding_logo_url as string | undefined) ?? (body.logo_url as string | undefined) ?? (body.brandingLogoUrl as string | undefined),
		branding_theme: (body.branding_theme as string | undefined) ?? (body.theme as string | undefined),
		custom_domain: body.custom_domain as string | undefined,
		is_public: body.is_public as string | number | boolean | null | undefined,
	});
	if (!result.ok) return json({ error: result.error }, 400);
	return json({ page: result.page }, 201);
};
