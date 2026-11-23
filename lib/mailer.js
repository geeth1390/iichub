'use strict';
// Email sending through Resend's HTTP API. With no RESEND_API_KEY the
// app still runs: emails are not sent and the caller is told so.

function mailEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function sendEmail(to, subject, text) {
  if (!mailEnabled()) return { sent: false, reason: 'email not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
  return { sent: true };
}

module.exports = { mailEnabled, sendEmail };
