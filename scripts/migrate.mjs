import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Applies every migration in ./migrations (in filename order) to the D1 database
// using Wrangler's built-in, tracked migration system. Wrangler records applied
// migrations in a `d1_migrations` table, so this is idempotent: re-running it only
// applies migrations that haven't run yet.
//
//   npm run db:migrate            -> local D1 (.wrangler/state, used by `astro dev`)
//   npm run db:migrate -- --remote (or npm run db:migrate:remote) -> production D1
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remote = process.argv.includes('--remote');
const target = remote ? '--remote' : '--local';

const result = spawnSync(
	'npx',
	['wrangler', 'd1', 'migrations', 'apply', 'uptimecove-db', target],
	{ cwd, stdio: 'inherit', shell: true },
);

process.exit(result.status ?? 1);
