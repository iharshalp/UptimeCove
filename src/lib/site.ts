import { env } from 'cloudflare:workers';

const FALLBACK_SITE_NAME = 'UptimeCove';

/**
 * Display name for this instance, from `vars.PUBLIC_SITE_NAME` in
 * `wrangler.jsonc`. A fork can white-label its titles, social cards, structured
 * data and RSS feed without touching source.
 *
 * Read lazily rather than at module scope: `env` is only guaranteed to be
 * populated once the Worker is handling a request, and a plain `astro build`
 * (or a unit test importing a layout) has no bindings at all. Either way the
 * fallback keeps the page rendering instead of throwing.
 */
export function siteName(): string {
	try {
		return env?.PUBLIC_SITE_NAME?.trim() || FALLBACK_SITE_NAME;
	} catch {
		return FALLBACK_SITE_NAME;
	}
}
