import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteSession } from '../../../lib/sessions';

export const POST: APIRoute = async ({ cookies, request }) => {
	const cookieHeader = request.headers.get('cookie') ?? '';
	const match = cookieHeader.match(/(?:^|;\s*)uc_session=([^;]*)/);
	if (match) {
		try {
			const sid = decodeURIComponent(match[1]);
			await deleteSession(env, sid);
		} catch {}
	}
	cookies.delete('uc_session', { path: '/' });
	return Response.redirect(new URL('/', request.url), 303);
};
