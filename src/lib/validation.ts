const RESERVED_IPV4 = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.0\.0\./,
	/^192\.0\.2\./,
	/^192\.168\./,
	/^198\.(1[89])\./,
	/^198\.51\.100\./,
	/^203\.0\.113\./,
	/^(22[4-9]|23\d)\./,
	/^(24\d|25[0-5])\./,
];

function isUnsafeHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	if (host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
	return RESERVED_IPV4.some((pattern) => pattern.test(host));
}

export function validateMonitorUrl(value: unknown): { ok: true; url: URL } | { ok: false; error: string } {
	if (typeof value !== 'string' || value.length > 2048) return { ok: false, error: 'A valid URL is required' };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, error: 'A valid URL is required' };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Only HTTP and HTTPS URLs are supported' };
	if (url.username || url.password) return { ok: false, error: 'Credentials are not allowed in monitor URLs' };
	if (url.hash) return { ok: false, error: 'URL fragments are not allowed' };
	if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, error: 'Only ports 80 and 443 are allowed' };
	if (isUnsafeHostname(url.hostname)) return { ok: false, error: 'Private and reserved network targets are not allowed' };
	return { ok: true, url };
}

export function parseInteger(value: unknown, fallback: number, min: number, max: number): number | null {
	if (value === undefined || value === '') return fallback;
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
	return parsed;
}

export function safeRedirectPath(value: unknown): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/dashboard';
	return value;
}

export function validateBodySnippet(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
	if (value === undefined || value === null || value === '') return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
	if (value.length > 500) return { ok: false, error: `${field} must be 500 characters or less` };
	const trimmed = value.trim();
	if (trimmed === '') return { ok: true, value: null };
	return { ok: true, value: value };
}

export function validateMaxResponseTime(value: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
	if (value === undefined || value === null || value === '') return { ok: true, value: null };
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 500 || parsed > 30000) return { ok: false, error: 'max_response_time_ms must be an integer between 500 and 30000' };
	return { ok: true, value: parsed };
}

export function validateCustomHeaders(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
	if (value === undefined || value === null || value === '') return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'custom_headers must be a JSON string' };
	const trimmed = value.trim();
	if (trimmed === '') return { ok: true, value: null };
	if (trimmed.length > 4096) return { ok: false, error: 'custom_headers is too large' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: 'custom_headers must be valid JSON' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'custom_headers must be a JSON object' };
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof k !== 'string' || k.trim() === '') return { ok: false, error: 'custom_headers keys must be non-empty strings' };
		if (typeof v !== 'string') return { ok: false, error: 'custom_headers values must be strings' };
		if (k.length > 256 || v.length > 2048) return { ok: false, error: 'custom_headers key or value too long' };
		// Basic header name validation
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) return { ok: false, error: `Invalid header name: ${k}` };
	}
	return { ok: true, value: JSON.stringify(parsed) };
}
