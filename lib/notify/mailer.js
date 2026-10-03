import nodemailer from 'nodemailer';
import { redact } from '../llm/client.js';
import logger from '../services/logger.js';

/**
 * The environment variables SMTP needs (values only ever come from .env / the environment, never from the config).
 * `MAIL_TO` is optional: each user's alerts go to the address in their settings; MAIL_TO is the admin's fallback.
 */
export const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

const present = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * Reads the SMTP settings. Never returns or logs values for missing ones; error info is names only.
 * `SMTP_SECURE` is optional ("true"/"false"); by default TLS-on-connect is used for port 465 only.
 * @param {Record<string, string|undefined>} env
 * @returns {{settings: object|null, missing: string[], invalid: string[]}}
 */
export function readSmtpEnv(env) {
  const missing = SMTP_VARS.filter((name) => !present(env, name));
  const invalid = [];
  const port = Number(env.SMTP_PORT);
  if (!missing.includes('SMTP_PORT') && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    invalid.push('SMTP_PORT');
  }
  if (missing.length > 0 || invalid.length > 0) return { settings: null, missing, invalid };
  const secure = present(env, 'SMTP_SECURE') ? env.SMTP_SECURE.trim().toLowerCase() === 'true' : port === 465;
  return {
    settings: {
      host: env.SMTP_HOST.trim(),
      port,
      secure,
      user: env.SMTP_USER.trim(),
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM.trim(),
      to: present(env, 'MAIL_TO') ? env.MAIL_TO.trim() : null,
    },
    missing,
    invalid,
  };
}

/** The text a dry run prints for one email: subject and the full plain-text body (never the HTML, never secrets). */
export function formatDryRun({ subject, text, to }, reason) {
  return `[dry-run] would send email (${reason})\n${to ? `To: ${to}\n` : ''}Subject: ${subject}\n\n${text}\n`;
}

/**
 * The mail sender. Without complete SMTP settings, or with `dryRun`, it is a dry run: `send` prints the full email
 * (subject + plain text) through `print` and sends nothing. The notifier does not mark anything as announced in that
 * case, so real sending works once SMTP is set up.
 *
 * @param {object} [params]
 * @param {Record<string, string|undefined>} [params.env]
 * @param {boolean} [params.dryRun]
 * @param {(text: string) => void} [params.print] Where a dry run prints (default: the logger).
 * @param {typeof nodemailer.createTransport} [params.createTransport] Injectable for tests.
 * @returns {{dryRun: boolean, reason: string|null,
 *   send: (mail: {subject: string, text: string, html: string, to?: string}) => Promise<{sent: boolean}>}}
 *   `to` defaults to MAIL_TO.
 */
export function createMailer({
  env = process.env,
  dryRun = false,
  print = (text) => logger.info(text),
  createTransport = nodemailer.createTransport,
} = {}) {
  const { settings, missing, invalid } = readSmtpEnv(env);
  let reason = null;
  if (!settings) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid ${invalid.join(', ')}`);
    reason = `SMTP is not configured (${parts.join('; ')})`;
  } else if (dryRun) {
    reason = 'dry run';
  }

  if (reason !== null) {
    return {
      dryRun: true,
      reason,
      async send({ subject, text, to }) {
        print(formatDryRun({ subject, text, to }, reason));
        return { sent: false };
      },
    };
  }

  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
  });
  return {
    dryRun: false,
    reason: null,
    async send({ subject, text, html, to }) {
      const recipient = to ?? settings.to;
      if (!recipient)
        throw new Error('No recipient: set an email address in the notification settings (or MAIL_TO in .env).');
      try {
        await transport.sendMail({ from: settings.from, to: recipient, subject, text, html });
      } catch (error) {
        throw new Error(redact(error.message, [settings.pass, settings.user]));
      }
      return { sent: true };
    },
  };
}
