import { describe, expect, it } from 'vitest';
import { parseInteger, safeRedirectPath, validateMonitorUrl } from '../../src/lib/validation';

describe('validateMonitorUrl', () => {
	it('accepts https urls', () => {
		expect(validateMonitorUrl('https://example.com/health')).toMatchObject({ ok: true });
	});

	it('rejects private ipv4 ranges', () => {
		expect(validateMonitorUrl('http://10.0.0.1/')).toMatchObject({ ok: false });
		expect(validateMonitorUrl('http://192.168.1.10/')).toMatchObject({ ok: false });
		expect(validateMonitorUrl('http://127.0.0.1/')).toMatchObject({ ok: false });
	});

	it('rejects localhost', () => {
		expect(validateMonitorUrl('http://localhost:3000/')).toMatchObject({ ok: false });
	});

	it('rejects credentials and fragments', () => {
		expect(validateMonitorUrl('https://user:pass@example.com/')).toMatchObject({ ok: false });
		expect(validateMonitorUrl('https://example.com/#frag')).toMatchObject({ ok: false });
	});

	it('rejects non-default ports', () => {
		expect(validateMonitorUrl('https://example.com:8443/')).toMatchObject({ ok: false });
	});

	it('rejects unsupported protocols', () => {
		expect(validateMonitorUrl('ftp://example.com/')).toMatchObject({ ok: false });
	});
});

describe('parseInteger', () => {
	it('uses fallback for missing values', () => {
		expect(parseInteger(undefined, 60, 60, 86400)).toBe(60);
		expect(parseInteger('', 200, 100, 599)).toBe(200);
	});

	it('accepts valid integers', () => {
		expect(parseInteger(200, 200, 100, 599)).toBe(200);
		expect(parseInteger('300', 60, 60, 86400)).toBe(300);
	});

	it('rejects invalid integers', () => {
		expect(parseInteger(1.5, 60, 60, 86400)).toBeNull();
		expect(parseInteger('NaN', 60, 60, 86400)).toBeNull();
		expect(parseInteger(Infinity, 60, 60, 86400)).toBeNull();
		expect(parseInteger(10, 60, 60, 86400)).toBeNull();
	});
});

describe('safeRedirectPath', () => {
	it('allows normal dashboard paths', () => {
		expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
	});

	it('blocks scheme-relative and backslash redirects', () => {
		expect(safeRedirectPath('//evil.example')).toBe('/dashboard');
		expect(safeRedirectPath('/\\evil')).toBe('/dashboard');
		expect(safeRedirectPath('https://evil.example')).toBe('/dashboard');
	});
});
