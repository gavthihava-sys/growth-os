import nodemailer from 'nodemailer'

let transport
function getTransport() {
  if (transport) return transport
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null
  transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT || 587) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  return transport
}

export async function sendEmail({ to, subject, text, html, replyTo }) {
  const mailTransport = getTransport()
  if (!mailTransport) {
    const safePreview = String(text || '').replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    console.log(`[email preview] to=${to} subject=${subject}\n${safePreview}`)
    return { delivered: false, preview: true }
  }
  await mailTransport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html, ...(replyTo ? { replyTo } : {}) })
  return { delivered: true }
}
