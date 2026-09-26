# 0009. Transactional email via Resend's HTTPS API

- **Status**: Accepted
- **Date**: 2026-09-26

## Context

The password-reset flow (`POST /api/auth/forgot-password` → emailed link →
`POST /api/auth/reset-password`) was fully implemented apart from delivery: the reset token
was returned in the HTTP response body in non-production and simply dropped in production,
so the flow dead-ended for real users.

The production API runs on a DigitalOcean Droplet (see `/memories/repo/vps-deploy-setup.md`).
DigitalOcean blocks outbound SMTP ports **25, 465 and 587** on all Droplets by default,
including traffic via Reserved IPs, and has no first-party email-sending product. Their own
docs direct users to a third-party provider. Unblocking SMTP requires a support ticket and
account review, and self-hosting a mail server on a DO IP range has poor deliverability.

Expected volume is a handful of emails per month (personal-scale app).

## Decision

Transactional email is sent through **Resend's HTTPS REST API** (`POST https://api.resend.com/emails`)
from `src/lib/mailer.ts`, called with plain `fetch` — no SDK and no new runtime dependency
beyond what Node 22 provides.

- HTTPS on port 443 sidesteps the SMTP block entirely; no support ticket needed.
- Resend's free tier (3,000 emails/month, 100/day) covers this system's volume indefinitely.
- DKIM/SPF/DMARC records live in the DigitalOcean DNS zone for `trufflesinvestment.com.au`,
  which we already control.
- When `RESEND_API_KEY` is unset (local dev, CI), `sendEmail` logs the message instead of
  sending, so the flow stays exercisable without secrets or network access.
- Config: `RESEND_API_KEY`, `MAIL_FROM`, and `APP_URL` (the frontend origin used to build
  emailed links; falls back to `CORS_ORIGIN`, then `http://localhost:3000`).

Two hardening changes landed with it:

- `PasswordResetToken.token` now stores a **SHA-256 hash** of the token. The raw value only
  ever exists in the email link, so a database leak cannot be replayed as a reset.
- `POST /api/auth/forgot-password` is rate-limited to 5 requests/hour keyed on IP **and**
  target email (`express-rate-limit`). This required `app.set('trust proxy', 1)` in
  `src/index.ts`, since Nginx is a single hop in front of the app.

## Consequences

- A provider outage cannot break the endpoint: delivery failures are logged and the handler
  still returns the same generic 200, preserving the anti-enumeration property.
- Swapping providers means rewriting one `fetch` call in `src/lib/mailer.ts`; nothing else
  in the codebase knows about Resend.
- Sender reputation and deliverability are the provider's problem, not the Droplet's.
- Exceeding the free tier (3,000/month) requires a paid plan — not a concern at current
  scale, but worth watching if signups ever open up.
- `app.set('trust proxy', 1)` means the app trusts the last `X-Forwarded-For` hop. That is
  correct behind the current Nginx config; it would need revisiting if the proxy topology
  changes (e.g. an additional CDN/load balancer in front).
- Revisit this ADR if emailed tax-report PDFs are ever added (see ADR 0004), since
  attachments and larger volume would change the provider calculus.
