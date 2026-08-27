# Security Policy

## Reporting a vulnerability

Please report suspected security issues privately rather than opening a public GitHub issue.

Recommended disclosure:
- open a private security advisory in GitHub, or
- contact the repository maintainers directly

Include:
- affected file or route
- reproduction steps
- impact assessment
- whether a fix or mitigation is known

## Supported scope

This project is early-stage and currently uses a single shared `ADMIN_TOKEN`.
If you deploy UptimeCove, treat:

- `ADMIN_TOKEN`
- `.dev.vars`
- `wrangler` remote D1/KV state

as sensitive deployment secrets.

## Hardening notes

Current protections include:

- strict monitor URL validation
- redirect target validation
- normalized public incident causes
- safe redirect handling for login `next`

Planned follow-up hardening includes broader session, rate-limiting, and notification security improvements in later phases.
