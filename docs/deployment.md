# Deployment

Production topology: `piggy-api` on a DigitalOcean VPS, `piggy-fe` on Vercel.

## Accounting foundation release gate

Deploying additive accounting migrations and UI code does **not** activate real accounts.
Opening drafts remain inactive; gated live writers require a matching confirmed statement
and active ledger, and there is no user-facing provisioning flow yet. Do not manually seed
production ledger state to bypass the [foundation plan's cutover gates](./portfolio-foundation-plan.md#remaining-increment-2-steps-implement-in-this-order).

Manual trade voids retain source trades/operations and append terminal reversal audits;
the additive `voidedAt` columns do not delete data or change old PDF revisions. Deploy backend
migrations/code before dependent frontend changes, through the existing pipelines only.
Pull the frontend contract from the committed backend and include generated context in both
milestone commits. Rehearse migrations/backup restoration before controlled cutover.

Before enablement, implement live funding/revisions, cash review, ordinary ledger-entry routing,
and explicit retry-safe account confirmation. Keep imported voids, financial moves and protected
record deletion blocked. Future rollback/disable procedures must retain postings and prevent
legacy financial writers from creating a divergent history; no production cutover/rollback
procedure is delivered merely by this documentation.

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

### Scheduled jobs

- **Account purge** — deleting a user account only sets `deletedAt`/`purgeAfter`; the row and
  all its data survive until `yarn db:purge-deleted-users` runs after the 30-day grace period.
  This must be scheduled on the VPS or deleted accounts are never actually erased, which
  defeats the point of offering deletion at all (APP 11.2 / GDPR Art. 17). Daily is enough:

  ```cron
  # crontab -e as the deploy user
  15 3 * * * cd /var/www/piggy-api && /usr/bin/node dist/scripts/purge-deleted-users.js >> /var/log/piggy-purge.log 2>&1
  ```

  The job is idempotent — running it when nothing is due is a no-op.
  Each delete rechecks `deletedAt` and `purgeAfter` atomically, so an account restored
  after the initial due-user scan is not erased or reported as purged.
  Participating account/trade/import writes acquire a shared user-row barrier before
  account locks; soft deletion/restoration and purge serialize through the user row.
  A restore that commits before the conditional purge delete is preserved. A purge that
  commits first makes subsequent restoration fail rather than issuing an orphan session.

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
