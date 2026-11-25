/**
 * POST /api/import/analyze  — Parse PDFs and return extracted data for review
 * POST /api/import/confirm  — Save confirmed statements (creates properties/accounts as needed)
 */
import { Router, Request, Response } from 'express';
import { propertyLimitReached } from '../services/planLimits';
import { findExistingBill } from '../services/billMatch';
import { applyPolicyDocument, settleInFull } from '../services/pdfImportService';
import { parseBill, applyPastDueNotice, recordConfirmedPayment, normalizeAcct, ExtractedBillData, MatchResult } from '../services/pdfImportService';
import { encrypt, decrypt } from '../crypto/encrypt';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { attachDbUser } from '../middleware/requireAuth';
import { db } from '../config/db';
import { fileCardStatement } from '../services/cardIntake';
import { recordNotice } from '../services/noticeTracker';
import { fileServiceInvoice } from '../services/expenseIntake';
import { isEmailPrintout } from '../services/emailPrintouts';
import { classifyUpload } from '../services/uploadKind';
import { compareWithOwner, ownerEntered, sameBillByDue, thinnerThan } from '../services/statementConflict';
import { saveStatement, buildRawData } from '../services/saveStatement';

const router = Router();

// All import routes need the DB user
router.use(attachDbUser);

// ── Accounts refresh — called when user creates a new account mid-review ──────
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          // serviceLabel and the masked number travel with the account so the
          // picker can tell two meters for one provider apart — the provider
          // name and category are identical between them.
          select: { id: true, providerName: true, category: true, serviceLabel: true, accountNumber: true, isPersonal: true, memberId: true },
          orderBy: { providerName: 'asc' },
        },
      },
      orderBy: { address: 'asc' },
    });
    return res.json({ properties });
  } catch (err) {
    console.error('[Import] Accounts refresh error:', err);
    return res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// ── Classify: what each file dropped on Add is, so it reaches the right importer ──
// Body { files: [{ name, data (base64), mimeType }] } -> { kinds: [{ name, kind }] }.
router.post('/classify', async (req: Request, res: Response) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 50) : [];
    const kinds = [];
    for (const f of files) {
      if (typeof f?.data !== 'string' || typeof f?.name !== 'string') continue;
      kinds.push({ name: f.name, kind: await classifyUpload(req.dbUserId!, Buffer.from(f.data, 'base64'), f.name, String(f.mimeType ?? '')) });
    }
    return res.json({ kinds });
  } catch (err) {
    console.error('[Import] Classify error:', err);
    return res.status(500).json({ error: 'Could not sort the files' });
  }
});

// ── Analyze: parse PDFs, stream results back via SSE ─────────────────────────
// Each bill is sent as soon as it finishes parsing — no waiting for the batch.

router.post('/analyze', async (req: Request, res: Response) => {
  const userId = req.dbUserId!;
  const { files, method } = req.body as { files: { name: string; data: string }[]; method?: 'ai' | 'regex' };

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }
  if (files.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 files per import' });
  }

  // SSE headers — keep connection open while Claude processes each file
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  // A comment line every 15 seconds: proxies close a stream that goes quiet
  // while Claude reads a long file, and the page then waits forever.
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);

  console.log(`[Import] Streaming analysis of ${files.length} PDF(s) for user ${userId}`);

  try {
    // Process ALL files in parallel — each streams its result the moment it's done
    await Promise.all(
      files.map(async (f) => {
        const buffer = Buffer.from(f.data, 'base64');
        const result = await parseBill(buffer, f.name, userId, method === 'regex' ? 'regex' : 'ai');
        send({ type: 'bill', ...result });
      })
    );

    // After all files done, send the accounts list for the dropdowns
    const properties = await db.property.findMany({
      where: { userId },
      include: {
        utilityAccounts: {
          // serviceLabel and the masked number travel with the account so the
          // picker can tell two meters for one provider apart — the provider
          // name and category are identical between them.
          select: { id: true, providerName: true, category: true, serviceLabel: true, accountNumber: true, isPersonal: true, memberId: true },
          orderBy: { providerName: 'asc' },
        },
      },
      orderBy: { address: 'asc' },
    });

    send({ type: 'done', properties });
  } catch (err) {
    console.error('[Import] Analyze error:', err);
    // The reason travels to the screen: "Cannot read x.pdf: it is a scan
    // with no text" is actionable where "Failed to analyze" is not.
    const message = err instanceof Error && err.message ? err.message.slice(0, 300) : 'Failed to analyze one or more files';
    send({ type: 'error', message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ── Confirm: save reviewed statements ────────────────────────────────────────

interface NewPropertyPayload {
  address:  string;
  city:     string;
  state:    string;
  zip:      string;
  nickname: string;
  type:     string;
}

interface NewAccountPayload {
  providerName:  string;
  providerSlug:  string;
  category:      string;
  accountNumber: string;
}

interface ConfirmItem {
  filename:         string;
  fileData:         string;           // base64 PDF
  extracted:        ExtractedBillData;
  match:            MatchResult;
  extractedBy?:     'ai' | 'text';    // which extractor actually produced `extracted`
  utilityAccountId: string | null;    // existing account OR null if creating new
  propertyId?:      string | null;    // existing property to add a new account to
  newProperty?:     NewPropertyPayload;
  newAccount?:      NewAccountPayload;
  /** The owner picked this account on the card, rather than accepting the importer's match. */
  ownerChose?:      boolean;
  /** The bill disagreed with a statement the owner entered by hand, and they chose to keep theirs. */
  keepMine?:        boolean;
  /** A one-time invoice recorded as an expense: on this property (null = personal), in this category. */
  expensePropertyId?: string | null;
  expenseCategory?:   string | null;
  /**
   * The owner's own (or a household member's, memberId): a new account is a personal bill, kept with
   * the property chosen but out of its costs; a card statement's new card and an invoice's expense
   * are that person's.
   */
  personal?: { memberId: string | null } | null;
}

const last4Of = (n?: string | null) => (n ? n.replace(/[^0-9A-Za-z]/g, '').slice(-4) || null : null);

/** The account on a property this new account already is: the same provider, and the same number when both have one. */
async function sameAccount(propertyId: string, na: NewAccountPayload) {
  const mine = last4Of(na.accountNumber);
  const rows = await db.utilityAccount.findMany({
    where: { propertyId, providerName: { equals: na.providerName, mode: 'insensitive' } },
    select: { id: true, accountNumber: true },
  });
  return rows.find(a => { const theirs = last4Of(a.accountNumber); return !mine || !theirs || theirs === mine; }) ?? null;
}

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const userId = req.dbUserId!;
    const { items } = req.body as { items: ConfirmItem[] };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items to confirm' });
    }

    let imported = 0;
    let skipped  = 0;
    let notices  = 0;
    const errors: string[] = [];

    // Dedup maps — keyed by normalized address / `propertyId:providerName`
    // so multiple statements for the same new property/account don't create duplicates
    const createdProperties: Record<string, string> = {};  // addrKey → propertyId
    const createdAccounts:   Record<string, string> = {};  // `${propId}:${provider}` → accountId

    const addrKey = (np: NewPropertyPayload) =>
      `${np.address}|${np.city}|${np.state}`.toLowerCase().replace(/\s+/g, ' ').trim();
    const acctKey = (propId: string, providerName: string) =>
      `${propId}:${providerName.toLowerCase().trim()}`;

    // Oldest first: a bill that reads its running totals against the bill
    // before it (AmTrust) needs that bill on file already.
    items.sort((a, b) => (a.extracted?.statementDate ?? '9999').localeCompare(b.extracted?.statementDate ?? '9999'));

    const members = new Set((await db.householdMember.findMany({ where: { userId }, select: { id: true } })).map(m => m.id));
    for (const item of items) {
      try {
        const personal = item.personal ? { memberId: item.personal.memberId && members.has(item.personal.memberId) ? item.personal.memberId : null } : null;
        // A credit card statement goes to its card (created if Sollux does
        // not have it), whatever account the card was left on.
        // A one-time invoice for work at a property: an expense on the property
        // the owner chose on the card (or a personal expense with none).
        if (item.extracted?.documentKind === 'service_invoice') {
          if (item.expensePropertyId) {
            const prop = await db.property.findFirst({ where: { id: item.expensePropertyId, userId }, select: { id: true } });
            if (!prop) { errors.push(`${item.filename}: property not found`); continue; }
          }
          const inv = await fileServiceInvoice(userId, personal ? null : item.expensePropertyId ?? null, item.extracted, item.fileData && !item.extracted.fromEmailBody ? Buffer.from(item.fileData, 'base64') : null, item.filename, item.expenseCategory);
          if (personal && !inv.duplicate) await db.expense.updateMany({ where: { id: inv.expenseId, userId }, data: { isPersonal: true, memberId: personal.memberId } });
          imported++;
          continue;
        }
        if (item.extracted?.documentKind === 'receipt' || item.extracted?.documentKind === 'estimate') { skipped++; continue; }
        if (item.extracted?.documentKind === 'credit_card_statement') {
          const card = await fileCardStatement(userId, item.extracted, item.fileData && !item.extracted.fromEmailBody ? Buffer.from(item.fileData, 'base64') : null, item.filename);
          // Whose card: said on the import card, for a card just added (one already on file keeps its person).
          if (personal && card.created) await db.creditCard.updateMany({ where: { id: card.cardId, userId }, data: { memberId: personal.memberId } });
          imported++;
          continue;
        }
        let utilityAccountId = item.utilityAccountId;
        let propertyId: string | null = null;

        // ── Add new account to existing property ──────────────────────────
        if (!utilityAccountId && item.propertyId && item.newAccount && !item.newProperty) {
          const na = item.newAccount;

          // Verify property belongs to user
          const existingProp = await db.property.findUnique({
            where: { id: item.propertyId },
            select: { id: true, userId: true },
          });
          if (!existingProp || existingProp.userId !== userId) {
            errors.push(`${item.filename}: property not found or access denied`);
            continue;
          }

          // Dedup: reuse account created earlier in this batch
          const key = `${acctKey(existingProp.id, na.providerName)}:${last4Of(na.accountNumber) ?? ''}`;
          if (createdAccounts[key]) {
            utilityAccountId = createdAccounts[key];
          } else {
            // Also check DB for an account that already exists with same provider — and the same
            // number when both have one: a second credit-union loan is not the first one's bills.
            const existingAcct = await sameAccount(existingProp.id, na);
            if (existingAcct) {
              utilityAccountId = existingAcct.id;
              createdAccounts[key] = existingAcct.id;
            } else {
              const acct = await db.utilityAccount.create({
                data: {
                  propertyId:    existingProp.id,
                  providerName:  na.providerName,
                  providerSlug:  na.providerSlug,
                  category:      (na.category as any) || 'OTHER',
                  accountNumber: na.accountNumber ? na.accountNumber.slice(-4) : null,
                  ...(personal ? { isPersonal: true, memberId: personal.memberId } : {}),
                },
              });
              utilityAccountId = acct.id;
              createdAccounts[key] = acct.id;
              console.log(`[Import] Created ${personal ? 'personal ' : ''}account ${acct.id} on existing property ${existingProp.id}`);
            }
          }
          propertyId = existingProp.id;
        }

        // ── Auto-create property + account if requested ────────────────────
        if (!utilityAccountId && item.newProperty && item.newAccount) {
          const np = item.newProperty;
          const na = item.newAccount;

          // Dedup property: reuse one created earlier in this batch
          const pKey = addrKey(np);
          if (createdProperties[pKey]) {
            propertyId = createdProperties[pKey];
          } else {
            // Also check DB for an existing property with the same address
            const existingProp = await db.property.findFirst({
              where: {
                userId,
                address: { equals: np.address, mode: 'insensitive' },
                city:    { equals: np.city,    mode: 'insensitive' },
              },
              select: { id: true },
            });
            if (existingProp) {
              propertyId = existingProp.id;
              createdProperties[pKey] = existingProp.id;
            } else {
              // The plan's property limit applies to imports too.
              const over = await propertyLimitReached(userId);
              if (over) { errors.push(`${item.filename}: ${over}`); continue; }
              const prop = await db.property.create({
                data: {
                  userId,
                  address:  np.address,
                  city:     np.city,
                  state:    np.state,
                  zip:      np.zip || '00000',
                  nickname: np.nickname || null,
                  type:     (np.type as any) || 'RENTAL',
                },
              });
              propertyId = prop.id;
              createdProperties[pKey] = prop.id;
              console.log(`[Import] Created property ${prop.id}`);
            }
          }

          // Dedup account on that property
          const aKey = `${acctKey(propertyId, na.providerName)}:${last4Of(na.accountNumber) ?? ''}`;
          if (createdAccounts[aKey]) {
            utilityAccountId = createdAccounts[aKey];
          } else {
            const existingAcct = await sameAccount(propertyId, na);
            if (existingAcct) {
              utilityAccountId = existingAcct.id;
              createdAccounts[aKey] = existingAcct.id;
            } else {
              const acct = await db.utilityAccount.create({
                data: {
                  propertyId,
                  providerName: na.providerName,
                  providerSlug: na.providerSlug,
                  category:     (na.category as any) || 'OTHER',
                  accountNumber: na.accountNumber ? na.accountNumber.slice(-4) : null,
                  ...(personal ? { isPersonal: true, memberId: personal.memberId } : {}),
                },
              });
              utilityAccountId = acct.id;
              createdAccounts[aKey] = acct.id;
              console.log(`[Import] Created account ${acct.id} on property ${propertyId}`);
            }
          }
        }

        if (!utilityAccountId) {
          errors.push(`${item.filename}: no utility account selected`);
          continue;
        }

        // Verify the account belongs to this user
        const acct = await db.utilityAccount.findUnique({
          where: { id: utilityAccountId },
          include: { property: { select: { id: true, userId: true } } },
        });

        if (!acct || acct.property.userId !== userId) {
          errors.push(`${item.filename}: account not found or access denied`);
          continue;
        }

        const ex = item.extracted;
        // A premium the lender pays from escrow, or billed once a term, is the
        // whole term paid once — not the first of the installments the
        // carrier also offers.
        settleInFull(ex, acct);

        // The bill names its account. If the chosen account names a different
        // one, this import would file one account's bill under another and
        // overwrite whatever that account had for the period — refuse, and
        // say which is which. An account with no number on file takes the
        // bill's, so the next import matches on it without asking.
        const billAcct = ex.accountNumber ? normalizeAcct(ex.accountNumber) : '';
        if (billAcct.length >= 6) {
          let stored = '';
          try { stored = acct.accountNumberEnc ? normalizeAcct(decrypt(acct.accountNumberEnc)) : ''; } catch { stored = ''; }
          if (stored.length >= 6 && !stored.includes(billAcct) && !billAcct.includes(stored)) {
            // Chosen by the importer, the account is a guess; a different number
            // means the guess is wrong. Chosen by the owner, it is a decision —
            // a policy renewed under a new number, a provider that renumbered —
            // so the bill files there and the account takes the bill's number.
            if (!item.ownerChose) {
              errors.push(`${item.filename}: this bill is for account ending ${billAcct.slice(-4)}, but the account it was matched to ends ${stored.slice(-4)}. Pick the account on the card to file it there anyway.`);
              continue;
            }
            await db.utilityAccount.update({
              where: { id: acct.id },
              data: {
                accountNumberEnc: encrypt(ex.accountNumber!),
                accountNumber: `****${ex.accountNumber!.replace(/\s/g, '').slice(-4)}`,
                notes: [acct.notes, `Account number changed from ending ${stored.slice(-4)} to ending ${billAcct.slice(-4)} on import of ${item.filename} (${new Date().toISOString().slice(0, 10)}).`].filter(Boolean).join('\n'),
              },
            });
          }
          if (!stored) {
            await db.utilityAccount.update({
              where: { id: acct.id },
              data: { accountNumberEnc: encrypt(ex.accountNumber!), accountNumber: `****${ex.accountNumber!.replace(/\s/g, '').slice(-4)}` },
            });
          }
        }

        // A past-due / disconnection notice is not a bill: it demands a
        // balance the real bills already carry and states no service period.
        // Filed as a statement it becomes a fake month of spending and counts
        // the same debt twice. Its aging table and shut-off date attach to
        // the account's newest statement instead.
        if (ex.documentKind === 'past_due_notice') {
          // Tracked on its own until paid, attached to a bill or not.
          await recordNotice(userId, utilityAccountId, ex, { source: 'upload' }).catch(err => console.warn('[Import] notice not recorded:', err instanceof Error ? err.message : err));
          const attached = await applyPastDueNotice(utilityAccountId, ex);
          if (attached) {
            notices++;
            continue;
          }
          // Nothing to attach it to. A carrier's cancellation notice that
          // names what is owed and by when is the only record of that money
          // on an account whose invoices never came, so it stands as the
          // bill for it: the total demanded, its fees, its cut-off date.
          if (ex.previousBalance != null && ex.previousBalance > 0 && ex.dueDate && ex.insurance) {
            ex.documentKind = 'bill';
            ex.amountDue = ex.previousBalance;
            ex.currentCharges = ex.previousBalance;
            ex.statedTotalDue = ex.previousBalance;
            ex.previousBalance = null;
          } else {
            // Tracked as a notice (above); there is no bill to attach it to yet.
            notices++;
            continue;
          }
        }
        // An insurance renewal offer, welcome letter or declarations page
        // describes the policy and its payment schedule; it bills nothing
        // itself. Filed as a bill it became a fake statement for the whole
        // term. Instead the policy is brought up to date and each scheduled
        // installment goes on the account as a bill-to-come.
        if (ex.documentKind === 'policy_document') {
          let docKey: string | undefined;
          if (item.fileData) {
            const docDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
            docKey = await uploadDocument(buildStatementKey(userId, acct.property.id, acct.id, docDate, sanitizeFilename(item.filename)), Buffer.from(item.fileData, 'base64'));
          }
          const filed = await applyPolicyDocument(utilityAccountId, ex, docKey);
          notices++;
          imported += filed;
          // A document that bills nothing and lists no payments files
          // nothing — which looked like a successful import of nothing.
          if (filed === 0) {
            const listed = ex.insurance?.paymentSchedule?.length ?? 0;
            errors.push(`${item.filename}: read as a ${ex.premiumFinance ? 'premium finance agreement' : 'policy document'} but ${listed === 0 ? 'no payment schedule could be read from it' : 'every listed payment already has a real bill on the account'}, so no statements were filed. ${listed === 0 ? 'Make sure the whole payment table (dates and amounts) is in the image, then import it again.' : ''}`.trim());
          }
          continue;
        }
        const filenameDate   = parseDateFromFilename(item.filename);
        const hasReliableDate = !!(ex.statementDate || filenameDate);
        const statementDate  = ex.statementDate
          ? new Date(ex.statementDate)
          : (filenameDate ?? new Date());

        // Infer billing period from statement month when not extracted (e.g.
        // management fees). Not for insurance: a premium bill issued in April
        // for a July term does not cover April, and an invented "Apr 1 – Apr
        // 30" row misstated what it billed. It keeps its coverage term when it
        // is paid in full, and no period otherwise.
        const insuranceNoPeriod = (!!ex.insurance || acct.category === 'INSURANCE') && !ex.billingPeriodStart;
        const billingPeriodStart = ex.billingPeriodStart
          ? new Date(ex.billingPeriodStart)
          : insuranceNoPeriod ? null : new Date(statementDate.getFullYear(), statementDate.getMonth(), 1);
        const billingPeriodEnd = ex.billingPeriodEnd
          ? new Date(ex.billingPeriodEnd)
          : insuranceNoPeriod ? null : new Date(statementDate.getFullYear(), statementDate.getMonth() + 1, 0);

        if (isNaN(statementDate.getTime())) {
          errors.push(`${item.filename}: invalid statement date`);
          continue;
        }

        // What makes two statements the same bill is the period they cover, not
        // the calendar month they were issued in. A cycle that drifts — IID
        // billed on 1 Jul and again on 31 Jul — puts two distinct bills in one
        // month, and a month-based key treated the second as a duplicate of
        // the first and overwrote it. That is why months whose bill arrived on
        // the 1st or 2nd of the next month appeared to be missing entirely.
        //
        // So: match on the billing period when the bill states one, and fall
        // back to the issue month only when it does not.
        let existing = null;
        // An insurance bill is never identified by a period: whatever period
        // it states is the policy's term, shared by every bill of the term,
        // and matching on it collapsed a year of statements into one row.
        const insuranceBill = !!ex.insurance || acct.category === 'INSURANCE';
        // Already on file? One rule for every importer (services/billMatch.ts).
        if (hasReliableDate) existing = await findExistingBill(utilityAccountId, ex, statementDate, { insuranceBill });

        // Upload PDF to S3
        let pdfS3Key: string | undefined;
        // An email's body is not the statement: its figures are filed, its
        // printout is not. Cards staged before this was known are recognised
        // by the stamp on the printout.
        if (item.fileData && !ex.fromEmailBody && await isEmailPrintout(Buffer.from(item.fileData, 'base64'))) ex.fromEmailBody = true;
        if (item.fileData && !ex.fromEmailBody) {
          const buf = Buffer.from(item.fileData, 'base64');
          const key = buildStatementKey(
            userId,
            acct.property.id,
            acct.id,
            statementDate,
            sanitizeFilename(item.filename),
          );
          pdfS3Key = await uploadDocument(key, buf);
        }

        // A bill settled in full reports amountDue 0 while still charging for
        // the period, so taking amountDue alone recorded $0.00 for a $328.03
        // bill — every paid month looked empty and the import looked like it
        // had done nothing. The period's charge is currentCharges; amountDue
        // is only the fallback. Matches scripts/import-local-statements.ts so
        // both import paths produce the same numbers.
        // An AmTrust invoice prints no "previous balance": its Minimum Payment
        // Due is everything unpaid — this month's installment, any fee added,
        // and whatever earlier bills asked for and did not get. The running
        // totals on the bill before it say which is which: what was billed
        // since is this bill's own charge, the rest is carried; what was paid
        // since is a payment received. (Without an earlier bill on file the
        // whole minimum is this bill's.)
        const ins = ex.insurance;
        if (ins?.billedToDate != null && ins.paidToDate != null && ex.statedTotalDue != null && !ex.previousBalance) {
          const prior = await db.statement.findFirst({
            where: { utilityAccountId, isScheduled: false, isDownPayment: false, statementDate: { lt: statementDate }, ...(existing ? { id: { not: existing.id } } : {}) },
            orderBy: { statementDate: 'desc' },
            select: { rawDataJson: true },
          });
          const prev = (prior?.rawDataJson as any)?.insurance ?? null;
          if (prev && prev.billedToDate != null && prev.paidToDate != null) {
            const fee = ins.serviceCharge ?? 0;
            const billedSince = Number((ins.billedToDate - prev.billedToDate).toFixed(2));
            const paidSince = Number((ins.paidToDate - prev.paidToDate).toFixed(2));
            const own = Math.min(ex.statedTotalDue, Math.max(0, Number((billedSince + fee).toFixed(2))));
            const carried = Number((ex.statedTotalDue - own).toFixed(2));
            ex.currentCharges = own; ex.amountDue = own; ex.previousBalance = carried > 0.005 ? carried : 0;
            if (paidSince > 0.005) ex.paymentsReceived = paidSince;
            // What was billed since, beyond whole installments, is fees: a
            // $20 late fee, a $50 reinstatement fee. The installment is the
            // smallest "Currently Due" any bill of the account has shown.
            const earlier = await db.statement.findMany({
              where: { utilityAccountId, isScheduled: false, isDownPayment: false, statementDate: { lt: statementDate } },
              orderBy: { statementDate: 'desc' }, take: 12, select: { rawDataJson: true },
            });
            const dues = [ins.currentlyDue, ...earlier.map(e => (e.rawDataJson as any)?.insurance?.currentlyDue)].filter((v): v is number => typeof v === 'number' && v > 0);
            const installment = dues.length ? Math.min(...dues) : null;
            if (installment) {
              const fees = Number((billedSince - Math.floor(billedSince / installment + 1e-6) * installment).toFixed(2));
              const premium = Number((billedSince - fees).toFixed(2));
              ex.lateFee = fees > 0.005 ? fees : null;
              const label = fees === 20 ? 'Late fee' : fees === 50 ? 'Reinstatement fee' : fees === 70 ? 'Late fee and reinstatement fee' : 'Late / reinstatement fees';
              ex.chargeBreakdown = {
                ...(premium > 0.005 ? { 'Premium installment': premium } : {}),
                ...(fee ? { 'Installment fee': fee } : {}),
                ...(fees > 0.005 ? { [label]: fees } : {}),
              };
            }
          }
          // A scheduled row for the whole term premium (from a policy package)
          // has no place on an account billed by the month.
          await db.statement.deleteMany({
            where: { utilityAccountId, isScheduled: true, payments: { none: {} }, amountDue: { gt: ex.statedTotalDue * 3 } },
          });
        }
        // A "your bill is ready" email and the PDF statement are one bill;
        // a reading thinner than what is on file only confirms it.
        if (!existing) existing = await sameBillByDue(utilityAccountId, ex);
        if (existing && thinnerThan(ex, existing)) {
          await recordConfirmedPayment(utilityAccountId, existing.id, ex);
          skipped++;
          continue;
        }

        // One way to save a bill (services/saveStatement.ts). A period the owner entered by hand keeps
        // their figures when the bill agrees, or when they chose "Keep mine" on the card; the PDF,
        // charge list and payments it lists are added either way.
        const keepOwner = !!existing && (!!item.keepMine || (ownerEntered(existing) && (await compareWithOwner(utilityAccountId, ex, existing)).kind === 'same'));
        const saved = await saveStatement({
          accountId: utilityAccountId, ex, statementDate, existing, keepOwner,
          rawData: buildRawData(ex, 'pdf_import', item.extractedBy), pdfS3Key: pdfS3Key ?? null,
          period: { start: billingPeriodStart, end: billingPeriodEnd }, pdf: 'replace', moveDate: true,
        });
        if (saved.outcome === 'new') imported++; else skipped++;
        if (saved.outcome === 'kept-owner') continue;

        // If this statement shows paymentsReceived > 0, the prior statement was paid.
        // Find the most recent prior statement with no amountPaid and mark it paid.
        if (ex.paymentsReceived && ex.paymentsReceived > 0) {
          const priorStmt = await db.statement.findFirst({
            where: {
              utilityAccountId,
              statementDate: { lt: statementDate },
              amountPaid: null,
            },
            orderBy: { statementDate: 'desc' },
          });
          if (priorStmt && priorStmt.amountDue != null) {
            const priorDue = Number(priorStmt.amountDue);
            if (ex.paymentsReceived >= priorDue - 0.01) {
              await db.statement.update({
                where: { id: priorStmt.id },
                data: { amountPaid: priorDue },
              });
            }
          }
        }
      } catch (err) {
        errors.push(`${item.filename}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }

    return res.json({ imported, notices, skipped, errors });
  } catch (err) {
    console.error('[Import] Confirm error:', err);
    return res.status(500).json({ error: 'Failed to save statements' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Try to parse a date from the filename, e.g. "7-8-26" → 2026-07-08 */
function parseDateFromFilename(filename: string): Date | null {
  const name = filename.replace(/\.[^.]+$/, '');
  // M-D-YY or MM-DD-YY or M-D-YYYY
  // Anchored to the end only: portals prefix exports ("eBill_08_24_2026").
  const m = name.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d;
  }
  return null;
}


function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export default router;
