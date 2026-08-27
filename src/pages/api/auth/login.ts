import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { safeRedirectPath } from '../../../lib/validation';
import { createSession } from '../../../lib/sessions';

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!env.ADMIN_TOKEN) {
		return new Response('ADMIN_TOKEN secret is not configured. Run: wrangler secret put ADMIN_TOKEN', { status: 500 });
	}

	const form = await request.formData();
	const token = String(form.get('token') ?? '');
	const next = safeRedirectPath(form.get('next'));

	if (token !== env.ADMIN_TOKEN) {
		return Response.redirect(new URL(`/login?error=Invalid+token&next=${encodeURIComponent(next)}`, request.url), 303);
	}

	const session = await createSession(env);
	cookies.set('uc_session', session.id, {
		path: '/',
		httpOnly: true,
		secure: import.meta.env.PROD,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7,
	});
	return Response.redirect(new URL(next, request.url), 303);
};
