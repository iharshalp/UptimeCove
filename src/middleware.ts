import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { validateSession } from './lib/sessions';
import { verifyApiKey } from './lib/auth';

const COOKIE_NAME = 'uc_session';

async function checkSession(request: Request): Promise<boolean> {
	const token = env.ADMIN_TOKEN;
	if (!token) return false;
	const cookies = request.headers.get('cookie') ?? '';
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
	if (!match) return false;
	let sessionId: string;
	try {
		sessionId = decodeURIComponent(match[1]);
	} catch {
		return false;
	}
	return validateSession(env, sessionId);
}

async function checkAuth(request: Request): Promise<{ isAdmin: boolean; actor: string | null; apiKey: { id: string; name: string; scopes: string } | null }> {
	// Check API key via Authorization: Bearer header first for /api/* routes
	const authHeader = request.headers.get('Authorization') ?? request.headers.get('authorization') ?? '';
	if (authHeader && /^Bearer\s+/i.test(authHeader)) {
		try {
			const result = await verifyApiKey(env, request);
			if (result.ok) {
				return {
					isAdmin: true,
					actor: result.actor ?? result.key.name,
					apiKey: { id: result.key.id, name: result.key.name, scopes: result.key.scopes },
				};
			}
		} catch {
			// fall through to session check
		}
	}
	const sessionOk = await checkSession(request);
	if (sessionOk) {
		return { isAdmin: true, actor: 'admin', apiKey: null };
	}
	return { isAdmin: false, actor: null, apiKey: null };
}

export const onRequest = defineMiddleware(async (context, next) => {
	const url = new URL(context.request.url);
	const auth = await checkAuth(context.request);
	context.locals.isAdmin = auth.isAdmin;
	context.locals.actor = auth.actor;
	context.locals.apiKey = auth.apiKey;

	// Routes that must stay reachable without credentials:
	//  - /api/status/*          public status page JSON + RSS
	//  - /api/auth/*            login/logout, which is how you get credentials
	//  - /api/badge/*           SVG badges embedded in READMEs by anonymous readers
	//  - /api/heartbeat/*/ping  dead-man's-switch pings; the URL itself is the
	//                           secret, and a cron job cannot carry a session cookie
	const isPublicApi =
		url.pathname === '/api/status' ||
		url.pathname.startsWith('/api/status/') ||
		url.pathname.startsWith('/api/auth/') ||
		url.pathname.startsWith('/api/badge/') ||
		/^\/api\/heartbeat\/[^/]+\/ping\/?$/.test(url.pathname);
	const isProtected =
		url.pathname.startsWith('/dashboard') ||
		(url.pathname.startsWith('/api/') && !isPublicApi);

	if (isProtected && !context.locals.isAdmin) {
		if (url.pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			});
		}
		return context.redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
	}

	return next();
});

export { COOKIE_NAME };
