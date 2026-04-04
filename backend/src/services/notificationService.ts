import sgMail from '@sendgrid/mail';
import twilio from 'twilio';

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── Email ─────────────────────────────────────────────────

export async function sendBillDueEmail(opts: {
  to: string;
  providerName: string;
  propertyAddress: string;
  amountDue: number;
  dueDate: string;
  daysUntilDue: number;
}) {
  const { to, providerName, propertyAddress, amountDue, dueDate, daysUntilDue } = opts;

  await sgMail.send({
    to,
    from: { email: process.env.SENDGRID_FROM_EMAIL!, name: process.env.SENDGRID_FROM_NAME || 'Sollux' },
    subject: `${providerName} bill due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'} — $${amountDue.toFixed(2)}`,
    html: `
      <div style="font-family: Inter, system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 28px;">
          <div style="width: 32px; height: 32px; background: #F5A623; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
            <div style="width: 14px; height: 14px; background: white; border-radius: 50%;"></div>
          </div>
          <span style="font-size: 18px; font-weight: 600; color: #1a1a1a;">Sollux</span>
        </div>
        <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">Bill due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}</h1>
        <p style="color: #666; font-size: 14px; margin: 0 0 24px;">${propertyAddress}</p>
        <div style="background: #FEF9EC; border: 1px solid #FAC775; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
          <p style="margin: 0 0 4px; font-size: 13px; color: #854F0B; font-weight: 500;">${providerName}</p>
          <p style="margin: 0 0 4px; font-size: 28px; font-weight: 600; color: #1a1a1a;">$${amountDue.toFixed(2)}</p>
          <p style="margin: 0; font-size: 13px; color: #666;">Due ${dueDate}</p>
        </div>
        <a href="${process.env.FRONTEND_URL}/payments" style="display: inline-block; background: #F5A623; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500;">View in Sollux →</a>
        <p style="margin-top: 32px; font-size: 12px; color: #999;">Sollux · sollux.net · You're receiving this because you enabled bill reminders.</p>
      </div>
    `,
  });
}

export async function sendAnomalyEmail(opts: {
  to: string;
  providerName: string;
  propertyAddress: string;
  currentAmount: number;
  avgAmount: number;
  deviationPct: number;
}) {
  const { to, providerName, propertyAddress, currentAmount, avgAmount, deviationPct } = opts;

  await sgMail.send({
    to,
    from: { email: process.env.SENDGRID_FROM_EMAIL!, name: 'Sollux' },
    subject: `⚠ ${providerName} bill is ${deviationPct}% above average`,
    html: `
      <div style="font-family: Inter, system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="font-size: 20px; font-weight: 600;">Bill spike detected</h1>
        <p style="color: #666; font-size: 14px;">${propertyAddress} · ${providerName}</p>
        <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 12px; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 8px; font-size: 22px; font-weight: 600; color: #DC2626;">$${currentAmount.toFixed(2)}</p>
          <p style="margin: 0; font-size: 14px; color: #666;">${deviationPct}% above your 3-month average of $${avgAmount.toFixed(2)}</p>
        </div>
        <a href="${process.env.FRONTEND_URL}/insights" style="display: inline-block; background: #F5A623; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500;">View AI insights →</a>
      </div>
    `,
  });
}

// ── SMS ───────────────────────────────────────────────────

export async function sendBillDueSMS(opts: {
  to: string;
  providerName: string;
  amountDue: number;
  dueDate: string;
  daysUntilDue: number;
}) {
  await twilioClient.messages.create({
    body: `Sollux: ${opts.providerName} bill of $${opts.amountDue.toFixed(2)} due in ${opts.daysUntilDue} day${opts.daysUntilDue === 1 ? '' : 's'} (${opts.dueDate}). Reply STOP to unsubscribe.`,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: opts.to,
  });
}

export async function sendAnomalySMS(opts: {
  to: string;
  providerName: string;
  deviationPct: number;
  currentAmount: number;
}) {
  await twilioClient.messages.create({
    body: `Sollux Alert: ${opts.providerName} bill ($${opts.currentAmount.toFixed(2)}) is ${opts.deviationPct}% above average. Check the app for details.`,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: opts.to,
  });
}
