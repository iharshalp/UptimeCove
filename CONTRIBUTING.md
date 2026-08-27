# Contributing

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Default URLs:
- `http://localhost:4321`
- `http://localhost:4321/status/default`

## Common commands

```bash
npm run check
npm run typecheck
npm run test
npm run build
npm run deploy:dry
```

## Migrations

- Add forward-only SQL files in `migrations/`
- Keep local and remote migration application consistent
- Verify schema changes with:
  - `npx wrangler d1 execute uptimecove-db --local --command "SELECT name FROM sqlite_master WHERE type='table';"`
  - `npx wrangler d1 execute uptimecove-db --local --command "SELECT sql FROM sqlite_master WHERE type='index';"`
