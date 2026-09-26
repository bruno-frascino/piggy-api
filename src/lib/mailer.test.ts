import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPasswordResetUrl,
  sendPasswordResetEmail,
  EmailDeliveryError,
} from './mailer.js'

const ORIGINAL_ENV = { ...process.env }

describe('mailer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.RESEND_API_KEY
    delete process.env.APP_URL
    delete process.env.CORS_ORIGIN
    delete process.env.MAIL_FROM
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  describe('buildPasswordResetUrl', () => {
    it('uses APP_URL when set', () => {
      process.env.APP_URL = 'https://app.example.com'
      expect(buildPasswordResetUrl('abc123')).toBe(
        'https://app.example.com/auth/reset-password?token=abc123'
      )
    })

    it('strips trailing slashes from the configured origin', () => {
      process.env.APP_URL = 'https://app.example.com//'
      expect(buildPasswordResetUrl('abc123')).toBe(
        'https://app.example.com/auth/reset-password?token=abc123'
      )
    })

    it('falls back to CORS_ORIGIN then localhost', () => {
      process.env.CORS_ORIGIN = 'https://cors.example.com'
      expect(buildPasswordResetUrl('t')).toBe(
        'https://cors.example.com/auth/reset-password?token=t'
      )

      delete process.env.CORS_ORIGIN
      expect(buildPasswordResetUrl('t')).toBe(
        'http://localhost:3000/auth/reset-password?token=t'
      )
    })

    it('url-encodes the token', () => {
      process.env.APP_URL = 'https://app.example.com'
      expect(buildPasswordResetUrl('a b&c')).toBe(
        'https://app.example.com/auth/reset-password?token=a%20b%26c'
      )
    })
  })

  describe('sendPasswordResetEmail', () => {
    it('logs instead of sending when no API key is configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

      await sendPasswordResetEmail('alice@example.com', 'https://reset.link')

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(info).toHaveBeenCalledOnce()
      expect(info.mock.calls[0][0]).toContain('alice@example.com')
    })

    it('posts to Resend with the configured sender and the reset link', async () => {
      process.env.RESEND_API_KEY = 'key_123'
      process.env.MAIL_FROM = 'Truffles <no-reply@example.com>'
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }))

      await sendPasswordResetEmail('alice@example.com', 'https://reset.link')

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://api.resend.com/emails')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer key_123'
      )

      const payload = JSON.parse(String(init?.body))
      expect(payload.from).toBe('Truffles <no-reply@example.com>')
      expect(payload.to).toEqual(['alice@example.com'])
      expect(payload.text).toContain('https://reset.link')
      expect(payload.html).toContain('https://reset.link')
    })

    it('throws EmailDeliveryError on a non-ok response', async () => {
      process.env.RESEND_API_KEY = 'key_123'
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 422 })
      )

      await expect(
        sendPasswordResetEmail('alice@example.com', 'https://reset.link')
      ).rejects.toBeInstanceOf(EmailDeliveryError)
    })

    it('throws EmailDeliveryError when the request fails outright', async () => {
      process.env.RESEND_API_KEY = 'key_123'
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

      await expect(
        sendPasswordResetEmail('alice@example.com', 'https://reset.link')
      ).rejects.toBeInstanceOf(EmailDeliveryError)
    })
  })
})
