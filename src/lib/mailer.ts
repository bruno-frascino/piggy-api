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
    'We received a request to reset your Truffles password.',
    '',
    `Reset it here (link expires in 1 hour): ${resetUrl}`,
    '',
    'If you did not request this, you can safely ignore this email — your password will not change.',
  ].join('\n')

  const html = [
    '<p>We received a request to reset your Truffles password.</p>',
    `<p><a href="${resetUrl}">Reset your password</a> — this link expires in 1 hour.</p>`,
    '<p>If you did not request this, you can safely ignore this email; your password will not change.</p>',
  ].join('')

  await sendEmail({ to, subject, text, html })
}
