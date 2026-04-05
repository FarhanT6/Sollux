import { google } from 'googleapis';
import pdf from 'pdf-parse';
import { db } from '../config/db';

const UTILITY_SENDERS = [
  'donotreply@sdge.com',
  'noreply@socalgas.com',
  'noreply@wm.com',
  'noreply@cox.com',
  'fpl.com',
  'noreply@iid.com',
  'noreply@republicservices.com',
  'noreply@tmobile.com',
  'noreply@att.com',
  'noreply@spectrum.com',
];

function getOAuthClient(accessToken: string, refreshToken: string) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Parse utility bills from Gmail for a user.
 * Searches the last 30 days for emails from known utility senders.
 */
export async function parseGmailForUser(userId: string): Promise<void> {
  const tokenRecord = await db.gmailToken.findUnique({ where: { userId } });
  if (!tokenRecord) return;

  const auth = getOAuthClient(tokenRecord.accessToken, tokenRecord.refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

  // Build search query for utility senders
  const senderQuery = UTILITY_SENDERS.map(s => `from:${s}`).join(' OR ');
  const query = `(${senderQuery}) newer_than:30d has:attachment`;

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const messages = listResponse.data.messages || [];
  console.log(`[GmailParser] Found ${messages.length} utility emails for user ${userId}`);

  for (const msg of messages) {
    try {
      await processEmailMessage(gmail, userId, msg.id!);
    } catch (err) {
      console.error(`[GmailParser] Error processing message ${msg.id}:`, err);
    }
  }
}

async function processEmailMessage(gmail: any, userId: string, messageId: string): Promise<void> {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = message.data.payload?.headers || [];
  const from = headers.find((h: any) => h.name === 'From')?.value || '';
  const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';
  const date = headers.find((h: any) => h.name === 'Date')?.value || '';

  // Match sender to a provider slug
  const senderToSlug: Record<string, string> = {
    'sdge.com': 'sdge',
    'socalgas.com': 'socal-gas',
    'wm.com': 'wm',
    'cox.com': 'cox',
    'fpl.com': 'fpl',
    'iid.com': 'iid',
    'republicservices.com': 'republic-services',
    'tmobile.com': 'tmobile',
    'att.com': 'att',
    'spectrum.com': 'spectrum',
  };

  const matchedSlug = Object.entries(senderToSlug).find(([domain]) => from.includes(domain))?.[1];
  if (!matchedSlug) return; // skip unknown senders

  // Find utility account for this user + provider
  const account = await db.utilityAccount.findFirst({
    where: {
      providerSlug: matchedSlug,
      property: { userId },
    },
  });

  if (!account) {
    console.log(`[GmailParser] No account found for slug ${matchedSlug}, userId ${userId}`);
    return;
  }

  // Derive statement date from email date header
  const statementDate = date ? new Date(date) : new Date();
  if (isNaN(statementDate.getTime())) return;

  // Avoid duplicate statements
  const existing = await db.statement.findFirst({
    where: { utilityAccountId: account.id, statementDate },
  });
  if (existing) return;

  // Find PDF attachments and extract billing data
  const parts = message.data.payload?.parts || [];
  let extractedData: Record<string, any> = {};

  for (const part of parts) {
    if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.body.attachmentId,
      });

      const pdfBuffer = Buffer.from(attachment.data.data, 'base64');

      try {
        const parsed = await pdf(pdfBuffer);
        extractedData = extractBillingData(parsed.text, from);
      } catch (pdfErr) {
        console.error('[GmailParser] PDF parse error:', pdfErr);
      }

      // Use data from the first successfully parsed PDF
      if (extractedData.amountDue !== undefined) break;
    }
  }

  console.log(`[GmailParser] Extracted from ${from}: amount=${extractedData.amountDue}, due=${extractedData.dueDate}`);

  // Save statement
  await db.statement.create({
    data: {
      utilityAccountId: account.id,
      statementDate,
      dueDate: extractedData.dueDate,
      amountDue: extractedData.amountDue,
      usageValue: extractedData.usageValue,
      usageUnit: extractedData.usageUnit,
      sourceType: 'EMAIL',
      rawDataJson: { from, subject, extractedData } as any,
    },
  });
  console.log(`[GmailParser] Saved statement for ${account.providerName}: $${extractedData.amountDue}`);
}

/**
 * Extract billing data from PDF text using regex patterns.
 */
function extractBillingData(text: string, sender: string): Record<string, any> {
  const result: Record<string, any> = {};

  // Amount due patterns
  const amountPatterns = [
    /amount\s+due[:\s]+\$?([\d,]+\.?\d{0,2})/i,
    /total\s+due[:\s]+\$?([\d,]+\.?\d{0,2})/i,
    /balance\s+due[:\s]+\$?([\d,]+\.?\d{0,2})/i,
    /pay\s+this\s+amount[:\s]+\$?([\d,]+\.?\d{0,2})/i,
  ];
  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.amountDue = parseFloat(match[1].replace(',', ''));
      break;
    }
  }

  // Due date patterns
  const dueDatePatterns = [
    /due\s+date[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /payment\s+due[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /due\s+by[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const pattern of dueDatePatterns) {
    const match = text.match(pattern);
    if (match) {
      const d = new Date(match[1]);
      if (!isNaN(d.getTime())) {
        result.dueDate = d;
        break;
      }
    }
  }

  // Usage (kWh, therms, gallons)
  const usagePatterns = [
    { pattern: /([\d.]+)\s*kWh/i, unit: 'kWh' },
    { pattern: /([\d.]+)\s*therms?/i, unit: 'therms' },
    { pattern: /([\d.]+)\s*CCF/i, unit: 'CCF' },
    { pattern: /([\d.]+)\s*gallons?/i, unit: 'gallons' },
  ];
  for (const { pattern, unit } of usagePatterns) {
    const match = text.match(pattern);
    if (match) {
      result.usageValue = parseFloat(match[1]);
      result.usageUnit = unit;
      break;
    }
  }

  // Account number
  const acctMatch = text.match(/account\s+(?:number|#)[:\s]+([A-Z0-9\s\-]+)/i);
  if (acctMatch) result.accountNumber = acctMatch[1].trim();

  return result;
}
