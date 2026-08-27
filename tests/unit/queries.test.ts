import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type StatementResult = { meta: { last_row_id?: number; changes?: number } };

function createDb(initialMonitors: Row[] = []) {
	const monitors: Row[] = [...initialMonitors];
	const calls: string[] = [];
	const db = {
		prepare(sql: string) {
			let bound: unknown[] = [];
			return {
				bind(...args: unknown[]) {
					bound = args;
					return this;
				},
				async first<T>() {
					calls.push(sql);
					if (sql.includes('SELECT * FROM monitors WHERE id =')) {
						return (monitors.find((row) => row.id === bound[0]) as T) ?? null;
					}
					return null;
				},
				async all<T>() {
					calls.push(sql);
					return { results: [] as T[] };
				},
				async run(): Promise<StatementResult> {
					calls.push(sql);
					if (sql.startsWith('INSERT INTO monitors')) {
						const id = monitors.length + 1;
						// Support both old 8-param and new 13-param inserts
						if (bound.length >= 13) {
							monitors.push({
								id,
								slug: bound[0],
								name: bound[1],
								url: bound[2],
								method: bound[3],
								expected_status: bound[4],
								interval_seconds: bound[5],
								timeout_ms: bound[6],
								body_must_contain: bound[7],
								body_must_not_contain: bound[8],
								max_response_time_ms: bound[9],
								custom_headers: bound[10],
								check_regions: bound[11],
								created_at: bound[12],
								enabled: 1,
								current_status: 'pending',
								consecutive_failures: 0,
								last_checked_at: null,
								next_check_at: 0,
								check_claimed_until: null,
								check_claim_token: null,
							});
						} else {
							monitors.push({
								id,
								slug: bound[0],
								name: bound[1],
								url: bound[2],
								method: bound[3],
								expected_status: bound[4],
								interval_seconds: bound[5],
								timeout_ms: bound[6],
								created_at: bound[7],
								body_must_contain: null,
								body_must_not_contain: null,
								max_response_time_ms: null,
								custom_headers: null,
								check_regions: null,
								enabled: 1,
								current_status: 'pending',
								consecutive_failures: 0,
								last_checked_at: null,
								next_check_at: 0,
								check_claimed_until: null,
								check_claim_token: null,
							});
						}
						return { meta: { last_row_id: id, changes: 1 } };
					}
					if (sql.startsWith('UPDATE monitors SET name =')) {
						const row = monitors.find((r) => r.id === bound[12]);
						if (row) {
							row.name = bound[0];
							row.url = bound[1];
							row.method = bound[2];
							row.expected_status = bound[3];
							row.interval_seconds = bound[4];
							row.timeout_ms = bound[5];
							row.body_must_contain = bound[6];
							row.body_must_not_contain = bound[7];
							row.max_response_time_ms = bound[8];
							row.custom_headers = bound[9];
							row.check_regions = bound[10];
						}
						return { meta: { changes: row ? 1 : 0 } };
					}
					return { meta: { changes: 1 } };
				},
			};
		},
		batch(statements: unknown[]) {
			return Promise.resolve(
				(statements as Array<{ run: () => Promise<StatementResult> }>).map(() => ({ meta: { changes: 1 } })),
			);
		},
	} as unknown as D1Database;

	return { db, monitors, calls };
}

describe('createMonitor', () => {
	beforeEach(() => {
		vi.stubGlobal('crypto', {
			// @ts-ignore test helper
			getRandomValues: (array: Uint8Array) => {
				array.fill(1);
				return array;
			},
			randomUUID: () => 'test-uuid',
		});
	});

	it('rejects invalid urls', async () => {
		const { createMonitor } = await import('../../src/lib/queries');
		const { db } = createDb();
		const result = await createMonitor({ DB: db } as unknown as Env, { name: 'Example', url: 'http://10.0.0.1/' });
		expect(result.ok).toBe(false);
	});

	it('creates monitors with normalized fields', async () => {
		const { createMonitor } = await import('../../src/lib/queries');
		const { db, monitors } = createDb();
		const result = await createMonitor({ DB: db } as unknown as Env, {
			name: 'Example',
			url: 'https://example.com/health',
			interval_seconds: 60,
		});
		expect(result.ok).toBe(true);
		expect(monitors[0].url).toBe('https://example.com/health');
	});

	it('rejects non-integer expected status', async () => {
		const { createMonitor } = await import('../../src/lib/queries');
		const { db } = createDb();
		const result = await createMonitor({ DB: db } as unknown as Env, {
			name: 'Example',
			url: 'https://example.com/',
			// @ts-ignore test helper
			expected_status: 200.5,
		});
		expect(result.ok).toBe(false);
	});
});
