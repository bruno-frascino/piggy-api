# Deployment

Production topology: `piggy-api` on a DigitalOcean VPS, `piggy-fe` on Vercel.

## piggy-api (VPS)

- Ubuntu droplet, deploy user `skinny` (sudoer, not root; root SSH + password auth disabled).
- Node 22 via NodeSource, managed by PM2 (`pm2 startup systemd -u skinny`).
- PostgreSQL installed natively (not Docker/managed) — db `piggy_db`, user `piggy_app`.
- Nginx reverse-proxies `api.trufflesinvestment.com.au` (ports 80/443, certbot TLS) to
  `localhost:4000`.
- `.env` lives at `/var/www/piggy-api/.env` (chmod 600): `DATABASE_URL`, JWT secrets,
  `NODE_ENV=production`, `DB_AUTO_MIGRATE=false` (migrations only run via the deploy
  pipeline's explicit `prisma migrate deploy` step, never automatically on boot).
- Deploy pipeline (`.github/workflows/deploy.yml`, `workflow_dispatch` only): build job
  (`yarn install --frozen-lockfile`, `prisma generate`, `tsc -p tsconfig.build.json`, bundles
  `dist/` + `prisma/` + `package.json`/`yarn.lock` + `prisma.config.ts`) → deploy job (scp
  bundle to `/var/www/piggy-api/incoming`, ssh in, swap in place, `yarn install --production
--frozen-lockfile`, `prisma generate`, `prisma migrate deploy`, `pm2 start-or-reload`).
  Required repo secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT`.
- `prisma.config.ts` (repo root, Prisma 7) must be included in every deploy bundle — it's
  where the CLI reads `datasource.url` from, not `schema.prisma`'s inline url.
- Root `tsconfig.json` has `noEmit: true` (editor/type-check only); the actual build uses
  `tsconfig.build.json` (`outDir: dist`, excludes `*.test.ts`) via the `build` script.

## piggy-fe (Vercel)

- Hosted on Vercel (free Hobby tier) rather than the same VPS — the droplet's RAM is too
  tight to also run a Next.js SSR process alongside the API + Postgres + Nginx.
- Custom domain `app.trufflesinvestment.com.au` (CNAME in DigitalOcean's DNS zone, since
  nameservers point to DO, not the registrar).
- Env vars on Vercel: `NEXT_PUBLIC_API_URL=https://api.trufflesinvestment.com.au/api`,
  `NEXT_PUBLIC_USE_MOCK_API=false`.
- Deploy via GitHub Actions → Vercel CLI (`.github/workflows/deploy.yml`), yarn-only
  (`yarn install --frozen-lockfile`, `yarn test --run`). Secrets: `VERCEL_TOKEN`,
  `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
- `CORS_ORIGIN` on the VPS `.env` must match the deployed frontend origin
  (`https://app.trufflesinvestment.com.au`); reload with `pm2 reload piggy-api --update-env`
  after changing it.

## Package manager

Both repos are yarn-only (`yarn@1.22.22` pinned via `packageManager` in `package.json`).
Use `corepack enable` locally so the pinned yarn version survives `nvm` Node version
switches — a plain `npm install -g yarn` disappears when `nvm` changes the active Node
version. See ADR `0006-yarn-only.md` in each repo.

## Node version

Both repos pin Node 22 via `.nvmrc`, matching the VPS (NodeSource `setup_22.x`) and CI
(`actions/setup-node` `node-version: 22`). Keep these three in lockstep if bumping Node.
