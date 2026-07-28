# 0006. Yarn only, no npm/pnpm (piggy-api)

- **Status**: Accepted
- **Date**: retro-documented 2026-07-28

## Context

Mixing package managers across contributors/agents (npm, pnpm, yarn) on the same repo
produces conflicting lockfiles (`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` committed
together) and can silently install different dependency trees between machines.

## Decision

This repo standardizes on **yarn 1.22.22** (`packageManager` pinned in `package.json`).
Only `yarn.lock` is committed. Do not run `npm install`, `npm ci`, or `pnpm install` in this
repo, and do not commit `package-lock.json` or `pnpm-lock.yaml`.

## Consequences

- Agents/scripts must invoke `yarn <script>` (e.g. `yarn test`, `yarn build`), not the npm
  equivalent, to match CI/deploy behavior exactly.
- If an npm/pnpm lockfile is ever accidentally created, delete it and reinstall with yarn
  before committing.
