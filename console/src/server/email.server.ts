/**
 * Outgoing mail: email OTP, invitations and password reset. SMTP everywhere except development and
 * tests, where messages are logged (env.server.ts refuses production without SMTP_URL).
 */
import { appendFileSync } from 'node:fs'

import nodemailer, { type Transporter } from 'nodemailer'

import { serverEnv } from './env.server'

export interface Mail {
  to: string
  subject: string
  text: string
}

let transport: Transporter | undefined

export async function sendMail(mail: Mail) {
  const env = serverEnv()
  if (!env.SMTP_URL) {
    if (env.NODE_ENV === 'production') throw new Error('SMTP_URL is not configured')
    if (env.MAIL_OUTBOX_FILE) appendFileSync(env.MAIL_OUTBOX_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...mail })}\n`)
    console.info(`[mail:${env.NODE_ENV}] to=${mail.to} subject=${mail.subject}\n${mail.text}`)
    return
  }
  transport ??= nodemailer.createTransport(env.SMTP_URL)
  await transport.sendMail({ from: env.MAIL_FROM, ...mail })
}
