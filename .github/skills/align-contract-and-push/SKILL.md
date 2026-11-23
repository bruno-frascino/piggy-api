---
name: align-contract-and-push
description: Prepare, commit, and push piggy-api and piggy-fe changes with aligned OpenAPI contracts and generated context. Use when the user asks Copilot to push changes or to commit and push either repository.
---

# Align contracts before pushing

This workflow applies when Copilot is asked to push, not when the user asks only to commit.
It covers the sibling `piggy-api` and `piggy-fe` checkouts. It does not intercept a user's
own `git push`; the existing Git hooks and CI remain separate safeguards.

## Safety and scope

1. Read both repositories' `AGENTS.md` and applicable scoped instructions. Inspect branch,
   upstream, remote, staged/unstaged/untracked changes and relevant commit history in both
   checkouts before running generators, staging or committing. Identify the changes explicitly
   covered by the user's request; a request to push does not authorize unrelated work.
2. Stop and ask the user if either checkout has unrelated or ambiguous uncommitted changes,
   generated-file changes that cannot safely be regenerated, an in-progress Git
   operation, or an unclear target branch/remote. Preserve all user changes. Do not stash,
   discard, amend, force-push, bypass hooks or run `git add -A` as a shortcut.
3. If an implementation is known to be unsafe or not release-ready, stop before committing or
   pushing it. Report the blocker. A successful contract check does not establish semantic
   compatibility, correctness, or production readiness.
4. Repair deterministic contract/context drift using the existing generators. If handwritten
   API, type or behavior incompatibilities need correction, stop and report them for review;
   do not silently change application behavior or automatically commit a guessed fix.

## Prepare both repositories before pushing

1. In `piggy-api`, run `yarn context:build`; a non-zero exit is a failure, including architecture
   violations. Review the generated diff and `context/openapi.json` against the requested API
   changes. Run `yarn context:check`, `yarn lint`, `yarn test --run`, and `yarn build`.
2. If backend changes must be committed, stage only explicitly in-scope files and their generated
   context. Create a new commit with this final trailer:
   `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Do not amend.
   Check the resulting commit and worktree. If pre-commit hooks stage anything outside scope, stop.
   The frontend contract must come from this committed backend state, not an uncommitted working
   tree. Confirm the committed `context/openapi.json` matches the file to be pulled.
3. In `piggy-fe`, compare `contracts/openapi.json` with the committed backend contract. If it
   differs, run `yarn contract:pull`, then `yarn context:build`. Also rebuild frontend context when
   frontend sources or the contract changed. Review generated files, contract metadata and
   `context/contract-drift.md`, as well as affected handwritten types and API consumers. The
   drift report checks component names and fields only; it is warning-only and misses inline
   schemas and many type/behavior changes. Never treat an empty report as proof of compatibility.
   If a handwritten incompatibility needs a fix, stop for review before pushing either repository.
4. Run `yarn contract:check`, `yarn context:check`, `yarn lint`, `yarn test --run`, and `yarn build`
   in `piggy-fe`. Stage and commit only the explicitly requested frontend work and resulting
   generated files. Verify the commit and clean generated artifacts. If only the generated
   contract/context changed, a separate `chore: sync backend contract` commit is appropriate.
5. Before any push, ensure both prepared commits pass the checks and no unrelated work would be
   included. If either repository has no changes to commit, do not create an empty commit.

## Push and verify

1. Push the backend first when it has in-scope commits to publish. Verify the intended remote
   ref contains the backend commit before pushing the frontend. Never force-push.
2. Frontend CI checks the backend **remote `main`** contract, not an arbitrary local or feature
   branch. Before pushing frontend `main`, verify its vendored contract matches the actual
   `piggy-api` remote `main` contract. If the intended backend commit is on another branch,
   remote `main` differs, or the remote cannot be verified, stop rather than predict CI success.
3. Push the frontend only after the backend dependency is published and verified. Two repositories
   cannot be pushed atomically: if either push fails, stop and report what was already published
   and what remains. Never claim both succeeded when only one did.
4. Report commits, pushed branches, checks and any remaining blockers. If the backend was
   committed but the frontend was not pushed, report that state explicitly.
