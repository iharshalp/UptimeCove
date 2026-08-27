import { describe, expect, it, vi } from 'vitest';
import { performCheck } from '../../src/lib/monitor';
import type { Monitor } from '../../src/types';

function monitor(overrides: Partial<Monitor> = {}): Monitor {
	return {
		id: 1,
		slug: 'example-abc123',
		name: 'Example',
		url: 'https://example.com/',
		method: 'GET',
		expected_status: 200,
		interval_seconds: 60,
		timeout_ms: 5000,
		enabled: 1,
		current_status: 'pending',
		consecutive_failures: 0,
		last_checked_at: null,
		next_check_at: 0,
		check_claimed_until: null,
		check_claim_token: null,
		created_at: Math.floor(Date.now() / 1000) - 3600,
		body_must_contain: null,
		body_must_not_contain: null,
		max_response_time_ms: null,
		custom_headers: null,
		check_regions: null,
		monitor_type: 'http',
		dns_expected_value: null,
		tcp_port: null,
		...overrides,
	} as Monitor;
}

describe('performCheck', () => {
	it('rejects unsafe monitor url before fetching', async () => {
		const result = await performCheck(monitor({ url: 'http://10.0.0.5/' }));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Private/);
	});

	it('rejects unsupported methods', async () => {
		const result = await performCheck(monitor({ method: 'POST' as Monitor['method'] }));
		expect(result.ok).toBe(false);
	});

	it('marks success on expected status', async () => {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
		const result = await performCheck(monitor());
		expect(result.ok).toBe(true);
		expect(result.status_code).toBe(200);
		vi.unstubAllGlobals();
	});

	it('marks failure on unexpected status', async () => {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }));
		const result = await performCheck(monitor({ expected_status: 200 }));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Expected 200/);
		vi.unstubAllGlobals();
	});

	it('validates redirect targets', async () => {
		vi.stubGlobal(
			'fetch',
			async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
		);
		const result = await performCheck(monitor());
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Unsafe redirect/);
		vi.unstubAllGlobals();
	});

	it('normalizes timeout errors', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new DOMException('aborted', 'AbortError');
		});
		const result = await performCheck(monitor({ timeout_ms: 1000 }));
		expect(result.error).toMatch(/Timeout/);
		vi.unstubAllGlobals();
	});
});
