import { describe, it, expect } from 'vitest';
import { createMailer, readSmtpEnv, SMTP_VARS } from '../../lib/notify/mailer.js';

const FULL = {
  SMTP_HOST: 'smtp.example.org',
  SMTP_PORT: '587',
  SMTP_USER: 'user@example.org',
  SMTP_PASS: 'hunter2-secret',
  MAIL_FROM: 'WG <from@example.org>',
  MAIL_TO: 'me@example.org',
};
const mail = { subject: 'S', text: 'plain body', html: '<p>x</p>' };

describe('#smtp env', () => {
  it('reports the missing variables by name only', () => {
    const r = readSmtpEnv({ SMTP_HOST: 'h', SMTP_PASS: 'secret' });
    expect(r.settings).toBeNull();
    expect(r.missing).toEqual(['SMTP_PORT', 'SMTP_USER', 'MAIL_FROM']);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('treats blank values as missing and rejects a bad port', () => {
    expect(readSmtpEnv({ ...FULL, SMTP_USER: '  ' }).missing).toEqual(['SMTP_USER']);
    expect(readSmtpEnv({ ...FULL, SMTP_PORT: 'abc' }).invalid).toEqual(['SMTP_PORT']);
  });

  it('parses a full config; secure defaults to port 465 and can be set', () => {
    expect(readSmtpEnv(FULL).settings).toMatchObject({ host: 'smtp.example.org', port: 587, secure: false });
    expect(readSmtpEnv({ ...FULL, SMTP_PORT: '465' }).settings.secure).toBe(true);
    expect(readSmtpEnv({ ...FULL, SMTP_SECURE: 'true' }).settings.secure).toBe(true);
    expect(readSmtpEnv({ ...FULL, SMTP_PORT: '465', SMTP_SECURE: 'false' }).settings.secure).toBe(false);
    expect(SMTP_VARS).not.toContain('MAIL_TO'); // optional: users have their own address, MAIL_TO is the admin fallback
    expect(readSmtpEnv(FULL).settings.to).toBe('me@example.org');
    const { MAIL_TO: _unused, ...withoutTo } = FULL;
    expect(readSmtpEnv(withoutTo).settings).toMatchObject({ to: null });
  });
});

describe('#mailer', () => {
  it('sends through the SMTP transport with from, to, subject, text and html', async () => {
    const sent = [];
    const created = [];
    const mailer = createMailer({
      env: FULL,
      createTransport: (opts) => (created.push(opts), { sendMail: async (m) => void sent.push(m) }),
    });
    expect(mailer.dryRun).toBe(false);
    const r = await mailer.send(mail);
    expect(r).toEqual({ sent: true });
    expect(created[0]).toMatchObject({ host: 'smtp.example.org', port: 587, secure: false });
    expect(created[0].auth).toEqual({ user: 'user@example.org', pass: 'hunter2-secret' });
    expect(sent).toEqual([
      { from: 'WG <from@example.org>', to: 'me@example.org', subject: 'S', text: 'plain body', html: '<p>x</p>' },
    ]);
  });

  it('sends to the given address instead of MAIL_TO; without any recipient it refuses', async () => {
    const sent = [];
    const mailer = createMailer({ env: FULL, createTransport: () => ({ sendMail: async (m) => void sent.push(m) }) });
    await mailer.send({ ...mail, to: 'anna@example.org' });
    expect(sent[0].to).toBe('anna@example.org');
    const { MAIL_TO: _unused, ...withoutTo } = FULL;
    const noDefault = createMailer({ env: withoutTo, createTransport: () => ({ sendMail: async () => {} }) });
    await expect(noDefault.send(mail)).rejects.toThrow(/No recipient/);
  });

  it('a dry run names the recipient', async () => {
    const printed = [];
    const mailer = createMailer({ env: {}, print: (s) => printed.push(s) });
    await mailer.send({ ...mail, to: 'anna@example.org' });
    expect(printed.join('\n')).toContain('To: anna@example.org');
  });

  it('is a dry run without complete SMTP config: prints, never sends, names the missing variables', async () => {
    const printed = [];
    const mailer = createMailer({
      env: { SMTP_HOST: 'h' },
      print: (s) => printed.push(s),
      createTransport: () => {
        throw new Error('must not connect');
      },
    });
    expect(mailer.dryRun).toBe(true);
    expect(mailer.reason).toMatch(/SMTP_PORT.*SMTP_USER.*SMTP_PASS.*MAIL_FROM/);
    expect(await mailer.send(mail)).toEqual({ sent: false });
    expect(printed.join('\n')).toContain('would send');
    expect(printed.join('\n')).toContain('Subject: S');
    expect(printed.join('\n')).toContain('plain body');
  });

  it('is a dry run when asked to, even with complete config, and never prints the password', async () => {
    const printed = [];
    const mailer = createMailer({
      env: FULL,
      dryRun: true,
      print: (s) => printed.push(s),
      createTransport: () => {
        throw new Error('must not connect');
      },
    });
    expect(mailer.dryRun).toBe(true);
    await mailer.send(mail);
    expect(printed.join('\n')).toContain('would send');
    expect(printed.join('\n')).not.toContain('hunter2-secret');
  });

  it('turns transport errors into redacted errors without the password', async () => {
    const mailer = createMailer({
      env: FULL,
      createTransport: () => ({
        sendMail: async () => {
          throw new Error('auth failed for hunter2-secret');
        },
      }),
    });
    await expect(mailer.send(mail)).rejects.toThrow(/auth failed for \[redacted\]/);
  });
});
