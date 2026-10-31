// Transactional email via Resend's HTTPS API. DigitalOcean blocks outbound SMTP
// ports (25/465/587) on Droplets, so an HTTPS provider is the only option here —
// see docs/adr/0009-transactional-email-provider.md.

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const REQUEST_TIMEOUT_MS = 10000

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailDeliveryError'
  }
}

interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

function appUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:3000'
  ).replace(/\/+$/, '')
}

export function buildPasswordResetUrl(rawToken: string): string {
  return `${appUrl()}/auth/reset-password?token=${encodeURIComponent(rawToken)}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

async function sendEmail(message: EmailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY

  // No key configured (local dev, CI): log instead of sending so the flow stays usable.
  if (!apiKey) {
    console.info(
      `[mailer] RESEND_API_KEY not set — email to ${message.to} not sent.\n${message.text}`
    )
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:
          process.env.MAIL_FROM ||
          'Truffles <no-reply@trufflesinvestment.com.au>',
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    })

    if (!response.ok) {
      throw new EmailDeliveryError(
        `Resend request failed with ${response.status}`
      )
    }
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error
    throw new EmailDeliveryError('Resend request failed or timed out')
  } finally {
    clearTimeout(timeout)
  }
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<void> {
  const subject = 'Reset your Truffles password'
  const text = [
    'Reset your Truffles password',
    '',
    'We received a request to reset the password for your Truffles account.',
    '',
    `Choose a new password: ${resetUrl}`,
    '',
    'This link expires in 1 hour and can only be used once.',
    'If the link has expired, request a new one from the Truffles sign-in page.',
    '',
    'Did not request a reset? You can ignore this email. Your password will stay the same.',
    'Keep this link private. Anyone with it can reset your password.',
    '',
    'Truffles | Your portfolio, clearly.',
  ].join('\n')

  const safeResetUrl = escapeHtml(resetUrl)
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Reset your Truffles password</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .email-canvas { background-color: #0e1420 !important; }
      .email-card { background-color: #161f2e !important; border-color: #334155 !important; }
      .email-text { color: #edf2fa !important; }
      .email-muted { color: #b1bed0 !important; }
      .email-notice { background-color: #1e293b !important; border-color: #334155 !important; }
      .email-link { color: #80b0ff !important; }
    }
    @media only screen and (max-width: 480px) {
      .email-padding { padding: 24px 20px !important; }
      .email-heading { font-size: 24px !important; }
    }
  </style>
</head>
<body class="email-canvas" style="margin:0;padding:0;background-color:#f6f7f9;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Choose a new password. Your reset link expires in 1 hour.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-canvas" style="background-color:#f6f7f9;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-card" style="max-width:560px;background-color:#ffffff;border:1px solid #e2e6ed;border-radius:16px;">
        <tr><td class="email-padding" style="padding:32px;">
          <p class="email-text" style="margin:0 0 28px;color:#172033;font-size:20px;font-weight:700;letter-spacing:-0.5px;">Truffles</p>
          <h1 class="email-heading email-text" style="margin:0 0 16px;color:#172033;font-size:28px;line-height:1.2;letter-spacing:-0.7px;">Reset your password</h1>
          <p class="email-muted" style="margin:0 0 24px;color:#586579;font-size:16px;line-height:1.6;">We received a request to reset the password for your Truffles account. Use the button below to choose a new password.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td bgcolor="#2563eb" style="background-color:#2563eb;border-radius:10px;text-align:center;">
              <a href="${safeResetUrl}" style="display:inline-block;padding:14px 24px;border:1px solid #2563eb;border-radius:10px;background-color:#2563eb;color:#ffffff;font-size:16px;line-height:20px;font-weight:700;text-decoration:none;mso-padding-alt:0;">
                <!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%;mso-text-raise:20pt;">&nbsp;</i><![endif]-->
                <span style="mso-text-raise:10pt;">Reset password</span>
                <!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%;">&nbsp;</i><![endif]-->
              </a>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-notice" style="background-color:#f0f2f6;border:1px solid #e2e6ed;border-radius:10px;">
            <tr><td style="padding:16px;">
              <p class="email-text" style="margin:0 0 6px;color:#172033;font-size:14px;line-height:1.5;font-weight:700;">This link expires in 1 hour and can only be used once.</p>
              <p class="email-muted" style="margin:0;color:#586579;font-size:14px;line-height:1.5;">If it has expired, request a new one from the Truffles sign-in page.</p>
            </td></tr>
          </table>
          <p class="email-muted" style="margin:24px 0 8px;color:#586579;font-size:14px;line-height:1.6;">If the button does not work, copy and paste this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere;"><a class="email-link" href="${safeResetUrl}" style="color:#2563eb;text-decoration:underline;word-break:break-all;">${safeResetUrl}</a></p>
          <p class="email-muted" style="margin:0 0 8px;color:#586579;font-size:14px;line-height:1.6;"><strong>Did not request a reset?</strong> You can ignore this email. Your password will stay the same.</p>
          <p class="email-muted" style="margin:0;color:#586579;font-size:14px;line-height:1.6;">Keep this link private. Anyone with it can reset your password.</p>
        </td></tr>
      </table>
      <p class="email-muted" style="margin:20px 0 0;color:#586579;font-size:12px;line-height:1.5;">Truffles &middot; Your portfolio, clearly.</p>
    </td></tr>
  </table>
</body>
</html>`

  await sendEmail({ to, subject, text, html })
}
