/**
 * Outgoing email (verification codes, password reset).
 * Provider: Resend (RESEND_API_KEY) or Brevo (BREVO_API_KEY). From address: EMAIL_FROM,
 * e.g. "SportLikely <no-reply@sportlikely.com>" — the domain must be verified with the provider.
 * With no provider configured, email is off and sign-ups are not asked for a code.
 */
import axios from 'axios';
import logger from '../utils/logger';

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const FROM = process.env.EMAIL_FROM || 'SportLikely <no-reply@sportlikely.com>';

export const emailProvider: 'resend' | 'brevo' | null = RESEND_KEY ? 'resend' : BREVO_KEY ? 'brevo' : null;
export const emailEnabled = !!emailProvider;

function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'SportLikely', email: m[2] } : { name: 'SportLikely', email: from.trim() };
}

export async function sendEmail(to: string, subject: string, html: string, text: string, replyTo?: string): Promise<void> {
  await sendMail({ to, subject, html, text, replyTo });
}

/**
 * Full options: a different From (e.g. support@), Reply-To, extra headers (List-Unsubscribe for campaigns).
 * fix216: returns the provider's message id (Resend webhooks report bounces / opens by it); `quiet` = no log line
 * (the picks emails log one summary per run). A failed call throws the axios error (status on e.response).
 */
export async function sendMail(o: { to: string; subject: string; html: string; text: string; replyTo?: string; from?: string; headers?: Record<string, string>; quiet?: boolean }): Promise<string | null> {
  if (!emailProvider) throw new Error('Email is not configured');
  const from = o.from || FROM;
  let id: string | null = null;
  if (emailProvider === 'resend') {
    const r = await axios.post(
      'https://api.resend.com/emails',
      { from, to: [o.to], subject: o.subject, html: o.html, text: o.text, ...(o.replyTo ? { reply_to: o.replyTo } : {}), ...(o.headers ? { headers: o.headers } : {}) },
      { headers: { Authorization: `Bearer ${RESEND_KEY}` }, timeout: 15000 }
    );
    id = r.data?.id ?? null;
  } else {
    const r = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      { sender: parseFrom(from), to: [{ email: o.to }], subject: o.subject, htmlContent: o.html, textContent: o.text, ...(o.replyTo ? { replyTo: { email: o.replyTo } } : {}), ...(o.headers ? { headers: o.headers } : {}) },
      { headers: { 'api-key': BREVO_KEY }, timeout: 15000 }
    );
    id = r.data?.messageId ?? null;
  }
  if (!o.quiet) logger.info(`Email sent (${emailProvider}): ${o.subject}`);
  return id;
}

/* ---------- shared look for every email we send ---------- */

export const SITE = `https://${process.env.CANONICAL_HOST || 'sportlikely.com'}`;
export const C = { ink: '#111419', muted: '#646c78', faint: '#969da8', line: '#e2e5ea', soft: '#f4f5f7', chip: '#f0f2f5', green: '#10a35a', amber: '#d98a06', red: '#d64545' };
export const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Card layout: brand header, optional label on the right, the body, a button, a footer note. Works in Gmail, Outlook and phones. */
export function layout(o: { preheader: string; label?: string; body: string; cta?: { text: string; href: string }; footer?: string }) {
  const btn = o.cta
    ? `<tr><td style="padding:8px 28px 28px"><a href="${esc(o.cta.href)}" style="display:inline-block;background:${C.green};color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">${esc(o.cta.text)}</a></td></tr>`
    : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;background:${C.soft};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:16px">
    <tr><td style="padding:22px 28px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-weight:800;font-size:18px">Sport<span style="color:${C.green}">Likely</span></td>
        ${o.label ? `<td align="right" style="font-size:12px;color:${C.faint};font-weight:600">${esc(o.label)}</td>` : ''}
      </tr></table>
    </td></tr>
    ${o.body}
    ${btn}
  </table>
  <p style="max-width:560px;font-size:11px;line-height:1.5;color:${C.faint};margin:16px auto 0">${o.footer ? `${o.footer}<br>` : ''}SportLikely · <a href="${SITE}" style="color:${C.faint}">sportlikely.com</a></p>
</td></tr></table></body></html>`;
}

/** A section heading inside the card. */
export const section = (title: string, note?: string) =>
  `<tr><td style="padding:22px 28px 6px"><div style="font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:${C.muted}">${esc(title)}</div>${note ? `<div style="font-size:12px;color:${C.faint};margin-top:3px">${esc(note)}</div>` : ''}</td></tr>`;

function codeEmail(title: string, intro: string, code: string, outro: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111419">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:460px;background:#ffffff;border:1px solid #e2e5ea;border-radius:16px" cellpadding="0" cellspacing="0">
      <tr><td style="padding:28px 28px 8px">
        <div style="font-weight:800;font-size:18px">Sport<span style="color:#10a35a">Likely</span></div>
        <h1 style="font-size:20px;margin:20px 0 8px">${title}</h1>
        <p style="font-size:14px;line-height:1.5;color:#646c78;margin:0 0 20px">${intro}</p>
        <div style="font-family:'JetBrains Mono',Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:8px;background:#f0f2f5;border-radius:12px;padding:16px;text-align:center">${code}</div>
        <p style="font-size:13px;line-height:1.5;color:#646c78;margin:20px 0 24px">${outro}</p>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#969da8;margin-top:16px">SportLikely · sportlikely.com</p>
  </td></tr></table></body></html>`;
  const text = `${title}\n\n${intro}\n\n${code}\n\n${outro}\n\nSportLikely · sportlikely.com`;
  return { html, text };
}

export function sendVerificationCode(to: string, code: string) {
  const { html, text } = codeEmail(
    'Confirm your email',
    'Enter this code on SportLikely to confirm your email address:',
    code,
    'The code is valid for 10 minutes. If you didn’t create an account, you can ignore this email.'
  );
  return sendEmail(to, `${code} is your SportLikely code`, html, text);
}

export function sendEmailChangeCode(to: string, code: string) {
  const { html, text } = codeEmail(
    'Confirm your new email',
    'Enter this code on SportLikely to move your account to this email address:',
    code,
    'The code is valid for 10 minutes. If you didn’t ask for this, you can ignore this email — nothing changes.'
  );
  return sendEmail(to, `${code} is your SportLikely code`, html, text);
}

/** Sent to the OLD address after the email of an account was changed. */
export function sendEmailChangedNotice(oldEmail: string, newEmail: string) {
  const masked = newEmail.replace(/^(.{2}).*(@.*)$/, '$1•••$2');
  const html = layout({
    preheader: 'The email of your SportLikely account was changed',
    label: 'Account security',
    body: `<tr><td style="padding:16px 28px 24px;font-size:15px;line-height:1.55">
      <p style="margin:0 0 12px">The email address of your SportLikely account was just changed to <b>${esc(masked)}</b>.</p>
      <p style="margin:0">If this was you, there is nothing to do. If it wasn’t, reply to this email or write to support@sportlikely.com right away so we can secure your account.</p>
    </td></tr>`
  });
  const text = `The email address of your SportLikely account was just changed to ${masked}.\nIf this was you, there is nothing to do. If it wasn't, write to support@sportlikely.com right away.`;
  return sendEmail(oldEmail, 'Your SportLikely email was changed', html, text, 'support@sportlikely.com');
}

export function sendResetCode(to: string, code: string) {
  const { html, text } = codeEmail(
    'Reset your password',
    'Enter this code on SportLikely to choose a new password:',
    code,
    'The code is valid for 10 minutes. If you didn’t ask to reset your password, you can ignore this email — your password stays the same.'
  );
  return sendEmail(to, `${code} is your SportLikely reset code`, html, text);
}
