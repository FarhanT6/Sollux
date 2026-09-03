import { Worker, Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { getScraperProvider } from '../scrapers/registry';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { guardWorker } from './redisGuard';
import { insightQueue, createWorkerConnection, workerTuning } from './queues';

interface ScrapeJobData {
  utilityAccountId: string;
}

// Normalise account number for matching (strip dashes/spaces/case)
function normalizeAcct(s: string) {
  return s.replace(/[-\s]/g, '').toLowerCase();
}

const worker = new Worker<ScrapeJobData>(
  'scrape',
  async (job: Job<ScrapeJobData>) => {
    const { utilityAccountId } = job.data;
    console.log(`[ScrapeWorker] Starting job for account ${utilityAccountId}`);

    // Fetch the triggering account
    const account = await db.utilityAccount.findUnique({
      where: { id: utilityAccountId },
      include: { property: { select: { id: true, userId: true } } },
    });

    if (!account) throw new Error(`Utility account ${utilityAccountId} not found`);
    if (!account.syncEnabled) {
      console.log(`[ScrapeWorker] Sync disabled for ${utilityAccountId}, skipping`);
      return;
    }

    // Decrypt credentials for the triggering account
    const username = account.usernameEnc ? decrypt(account.usernameEnc) : '';
    const password = account.passwordEnc ? decrypt(account.passwordEnc) : '';

    // ── Find all accounts for this user that share the same provider + login ──
    // When multiple utility accounts (e.g. 5 WM service addresses) use the same
    // username/password, we log in ONCE and scrape all of them in one session.
    const allProviderAccounts = await db.utilityAccount.findMany({
      where: {
        providerSlug: account.providerSlug,
        syncEnabled: true,
        property: { userId: account.property.userId },
      },
      include: { property: { select: { id: true, userId: true } } },
    });

    const sameCredAccounts = allProviderAccounts.filter(a => {
      if (!a.usernameEnc) return a.id === utilityAccountId;
      try { return decrypt(a.usernameEnc) === username; } catch { return false; }
    });

    console.log(
      `[ScrapeWorker] Scraping ${sameCredAccounts.length} ${account.providerSlug} account(s) in one session`
    );

    // Mark all of them PENDING
    await db.utilityAccount.updateMany({
      where: { id: { in: sameCredAccounts.map(a => a.id) } },
      data: { lastSyncStatus: 'PENDING' },
    });

    // Create sync job records
    const syncJobs = await Promise.all(
      sameCredAccounts.map(a =>
        db.syncJob.create({ data: { utilityAccountId: a.id, status: 'PENDING', startedAt: new Date() } })
      )
    );

    try {
      const scraper = getScraperProvider(account.providerSlug);
      if (!scraper) throw new Error(`No scraper found for provider: ${account.providerSlug}`);

      // Pass all tracked account numbers so the scraper only drills into those,
      // skipping any WM addresses the user hasn't added to Sollux.
      const accountNumbers = sameCredAccounts
        .map(a => (a.accountNumberEnc ? decrypt(a.accountNumberEnc) : null))
        .filter(Boolean) as string[];

      // Build a per-account-number map of latest statement dates.
      // Each account gets its own cutoff so a brand-new account (zero statements)
      // is never blocked by another account's already-stored date.
      const latestStmts = await db.statement.findMany({
        where: {
          utilityAccountId: { in: sameCredAccounts.map(a => a.id) },
          pdfS3Key: { not: null },   // only count statements where PDF was actually stored
        },
        orderBy: { statementDate: 'desc' },
        select: { utilityAccountId: true, statementDate: true },
      });

      // latestStatementDates: accountNumber → most recent statement date (for new-account guard)
      // knownStatementDates:  accountNumber → ALL stored dates as YYYY-MM-DD (for exact-date dedup)
      const latestStatementDates: Record<string, Date> = {};
      const knownStatementDates: Record<string, string[]> = {};
      for (const acct of sameCredAccounts) {
        const acctNum = acct.accountNumberEnc ? decrypt(acct.accountNumberEnc) : null;
        if (!acctNum) continue;
        const acctStmts = latestStmts.filter(s => s.utilityAccountId === acct.id);
        if (acctStmts.length > 0) {
          latestStatementDates[acctNum] = acctStmts[0].statementDate; // already sorted desc
          knownStatementDates[acctNum] = acctStmts.map(s =>
            s.statementDate.toISOString().slice(0, 10)   // YYYY-MM-DD
          );
        }
      }

      // Legacy single-date field: the global maximum across all accounts (for scrapers
      // that don't yet support per-account maps, e.g. single-account scrapers).
      const latestStatementDate = latestStmts.length > 0 ? latestStmts[0].statementDate : undefined;

      const credentials = { username, password, accountNumbers, latestStatementDate, latestStatementDates, knownStatementDates };
      const result = await scraper.run(credentials, utilityAccountId);

      if (!result.success) throw new Error(result.error || 'Scraper returned failure');

      // ── Distribute statements to the correct utility account by account number ──
      let totalInserted = 0;

      for (const acct of sameCredAccounts) {
        const acctNum = acct.accountNumberEnc ? decrypt(acct.accountNumberEnc) : null;
        let statementsInserted = 0;
        let paymentsInserted = 0;

        // Match statements to this utility account
        let matchingStmts: typeof result.statements;
        if (acctNum) {
          const filtered = result.statements.filter(stmt => {
            // Check rawData.accountNumber first; fall back to rsInfoProId for providers
            // that store their account identifier under a different key (e.g. Republic Services)
            const stmtAcctNum = (stmt.rawData?.accountNumber ?? stmt.rawData?.rsInfoProId) as string | undefined;
            if (!stmtAcctNum) return sameCredAccounts.length === 1; // single-account: take all
            const a = normalizeAcct(stmtAcctNum);
            const b = normalizeAcct(acctNum);
            // Strict match: exact OR one is a suffix of the other.
            // (RS stores "3-04670-041160" but API returns "4670041160" — same account, suffix match.)
            // Substring `includes` was too permissive — when account A's number contains
            // digit subsequences of account B's number, it falsely matched.
            if (a === b) return true;
            if (a.length >= 6 && b.endsWith(a)) return true;
            if (b.length >= 6 && a.endsWith(b)) return true;
            return false;
          });
          // Debug: log filter result so cross-account contamination is visible
          if (filtered.length !== result.statements.length) {
            console.log(`[ScrapeWorker] Account ${acct.accountNumber} filter: ${filtered.length}/${result.statements.length} statements kept (b=${normalizeAcct(acctNum)})`);
          }
          // If the account number filter matched nothing but this is the only account with
          // these credentials, the stored account number likely has a format mismatch
          // (e.g. RS uses infoProId "4670038334" but user stored "3-04670-038334").
          // Fall back to assigning all statements rather than silently importing nothing.
          if (filtered.length === 0 && sameCredAccounts.length === 1) {
            console.log(`[ScrapeWorker] Account number filter matched 0 statements for single account ${acct.id} — bypassing filter (format mismatch)`);
            matchingStmts = result.statements;
          } else {
            matchingStmts = filtered;
          }
        } else {
          // No account number stored on this Sollux account:
          // only assign statements to the account that triggered this sync job.
          // (If multiple accounts share the same creds and none has a stored number,
          //  assigning ALL statements to every account would create duplicates.)
          matchingStmts = sameCredAccounts.length === 1 || acct.id === utilityAccountId
            ? result.statements
            : [];
        }

        for (const stmt of matchingStmts) {
          let pdfS3Key: string | undefined;
          if (stmt.pdfBuffer && stmt.pdfFilename) {
            const key = buildStatementKey(
              acct.property.userId,
              acct.property.id,
              acct.id,
              stmt.statementDate,
              stmt.pdfFilename
            );
            pdfS3Key = await uploadDocument(key, stmt.pdfBuffer);
          }

          // A bill is its billing period, not its issue month: a drifting
          // cycle puts two bills in one month, and the plain month lookup this
          // used to be overwrote the first with the second. Match the period
          // when the scraper reports one; the month fallback still exists for
          // scrapers that do not (and for account-summary rows arriving with
          // today's date), but it may only claim rows without a real period —
          // a row with one is identified by it.
          let existing = null;
          if (stmt.billingPeriodStart) {
            const window = 7 * 24 * 60 * 60 * 1000;
            existing = await db.statement.findFirst({
              where: {
                utilityAccountId: acct.id,
                billingPeriodStart: {
                  gte: new Date(stmt.billingPeriodStart.getTime() - window),
                  lte: new Date(stmt.billingPeriodStart.getTime() + window),
                },
              },
            });
          }
          if (!existing) {
            const monthStart = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth(), 1);
            const monthEnd = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth() + 1, 0, 23, 59, 59);
            existing = await db.statement.findFirst({
              where: {
                utilityAccountId: acct.id,
                statementDate: { gte: monthStart, lte: monthEnd },
                ...(stmt.billingPeriodStart ? { billingPeriodStart: null } : {}),
              },
              orderBy: { createdAt: 'asc' }, // prefer the oldest (first scraped = real statement)
            });
          }

          const isPaid = stmt.rawData?.isPaid === true;
          const amountPaid = isPaid && stmt.amountDue ? stmt.amountDue : undefined;

          // balance = total amount currently owed (current charge + any past due).
          // Prefer the dedicated field from the scraper; fall back to totalDue / amountDue.
          const rawBalance = (stmt.rawData?.accountBalance ?? stmt.rawData?.totalDue) as number | undefined;
          const balance = rawBalance != null ? rawBalance
            : stmt.balance != null ? stmt.balance
            : undefined;

          if (!existing) {
            await db.statement.create({
              data: {
                utilityAccountId: acct.id,
                statementDate: stmt.statementDate,
                dueDate: stmt.dueDate,
                billingPeriodStart: stmt.billingPeriodStart,
                billingPeriodEnd: stmt.billingPeriodEnd,
                amountDue: stmt.amountDue,
                amountPaid,
                balance,
                usageValue: stmt.usageValue,
                usageUnit: stmt.usageUnit,
                ratePlan: stmt.ratePlan,
                pdfS3Key,
                rawDataJson: stmt.rawData as Prisma.InputJsonValue,
              },
            });
            statementsInserted++;
            totalInserted++;
          } else {
            // Update existing statement if:
            //  - paid status changed (user paid between syncs)
            //  - rawData has new/better info
            //  - existing is a stub (no PDF) but we now have a real PDF
            const wasUnpaid = !existing.amountPaid;
            const rawChanged = JSON.stringify(existing.rawDataJson) !== JSON.stringify(stmt.rawData);
            const isStubUpgrade = !!pdfS3Key && !existing.pdfS3Key;

            if ((isPaid && wasUnpaid) || rawChanged || isStubUpgrade) {
              await db.statement.update({
                where: { id: existing.id },
                data: {
                  ...(isPaid && wasUnpaid ? { amountPaid } : {}),
                  rawDataJson: stmt.rawData as Prisma.InputJsonValue,
                  // Update rich fields when upgrading from a stub or when scraper got better data
                  ...(stmt.dueDate ? { dueDate: stmt.dueDate } : {}),
                  ...(stmt.amountDue ? { amountDue: stmt.amountDue } : {}),
                  ...(balance != null ? { balance } : {}),
                  ...(stmt.billingPeriodStart ? { billingPeriodStart: stmt.billingPeriodStart } : {}),
                  ...(stmt.billingPeriodEnd ? { billingPeriodEnd: stmt.billingPeriodEnd } : {}),
                  ...(stmt.usageValue != null ? { usageValue: stmt.usageValue } : {}),
                  ...(stmt.usageUnit ? { usageUnit: stmt.usageUnit } : {}),
                  ...(stmt.ratePlan ? { ratePlan: stmt.ratePlan } : {}),
                  // Key: attach the real PDF when upgrading a stub
                  ...(isStubUpgrade ? { pdfS3Key } : {}),
                },
              });
              if (isStubUpgrade) {
                console.log(`[ScrapeWorker] Upgraded stub → real PDF for statement ${existing.id} (${stmt.statementDate.toISOString().slice(0, 10)})`);
                statementsInserted++;
                totalInserted++;
              }
            }
          }
        }

        // Payments routing:
        //  - If the scraped payment carries an accountNumber, route it to THAT account
        //    (WM scrapes Payment History per-account, so each payment is account-specific).
        //  - Otherwise (legacy single-account scrapers) fall back to assigning all payments
        //    to the triggering account only.
        const paymentsForAcct = acctNum
          ? result.payments.filter(pmt => {
              if (!pmt.accountNumber) {
                // No account tag → only the triggering account takes the payment, to avoid duplicates
                return acct.id === utilityAccountId;
              }
              return normalizeAcct(pmt.accountNumber) === normalizeAcct(acctNum);
            })
          : (acct.id === utilityAccountId ? result.payments : []);

        if (paymentsForAcct.length > 0) {
          for (const pmt of paymentsForAcct) {
            // Wrap amount in Prisma.Decimal explicitly. Passing a raw JS number lets
            // Prisma serialize it via a path where some IEEE-754 values (e.g. 961.57)
            // do NOT compare equal to the stored NUMERIC(10,2) value, so dedup misses
            // and a fresh copy gets inserted on every sync run. Using Decimal ensures
            // string-based exact comparison.
            // Dedup also includes confirmationNumber when present — without it, multiple
            // legit same-day same-amount payments (different transactions) would collide.
            const amtDecimal = new Prisma.Decimal(String(pmt.amount));
            const existing = await db.payment.findFirst({
              where: {
                utilityAccountId: acct.id,
                paymentDate: pmt.paymentDate,
                amount: amtDecimal,
                ...(pmt.confirmationNumber ? { confirmationNumber: pmt.confirmationNumber } : {}),
              },
            });
            // Helper: is this a "bad" placeholder value scraped incorrectly?
            const isBadConfirmation = (s?: string | null) =>
              !s || /^(number|n\/a|none|null|undefined)$/i.test(s.trim());
            // Single generic words are not useful payment methods
            const isBadMethod = (s?: string | null) =>
              !s || /^(online|automatic|checking|debit|credit|bank|payment)$/i.test(s.trim());

            if (!existing) {
              await db.payment.create({
                data: {
                  utilityAccountId: acct.id,
                  amount: pmt.amount,
                  paymentDate: pmt.paymentDate,
                  confirmationNumber: isBadConfirmation(pmt.confirmationNumber) ? null : pmt.confirmationNumber,
                  paymentMethod: isBadMethod(pmt.paymentMethod) ? null : pmt.paymentMethod,
                  status: 'PAID',
                },
              });
              paymentsInserted++;
            } else {
              // Update if we now have better data (confirmation # was missing or bad before)
              const needsUpdate =
                (isBadConfirmation(existing.confirmationNumber) && !isBadConfirmation(pmt.confirmationNumber)) ||
                (isBadMethod(existing.paymentMethod) && !isBadMethod(pmt.paymentMethod));
              if (needsUpdate) {
                await db.payment.update({
                  where: { id: existing.id },
                  data: {
                    confirmationNumber: isBadConfirmation(pmt.confirmationNumber) ? existing.confirmationNumber : pmt.confirmationNumber,
                    paymentMethod: isBadMethod(pmt.paymentMethod) ? null : pmt.paymentMethod,
                  },
                });
              }
            }
          }
        }

        // Mark this account SUCCESS
        await db.utilityAccount.update({
          where: { id: acct.id },
          data: { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null },
        });

        const syncJobForAcct = syncJobs.find(j => j.utilityAccountId === acct.id);
        if (syncJobForAcct) {
          await db.syncJob.update({
            where: { id: syncJobForAcct.id },
            data: { status: 'SUCCESS', completedAt: new Date(), statementsFound: statementsInserted, paymentsFound: paymentsInserted },
          });
        }

        // Queue insights for this property
        await insightQueue.add('generate', { propertyId: acct.property.id }, { delay: 2000, attempts: 2 });
      }

      console.log(`[ScrapeWorker] Done: ${totalInserted} new statements across ${sameCredAccounts.length} account(s)`);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[ScrapeWorker] Error for ${utilityAccountId}:`, message);

      // Mark all same-cred accounts failed
      await db.utilityAccount.updateMany({
        where: { id: { in: sameCredAccounts.map(a => a.id) } },
        data: { lastSyncStatus: 'FAILED', lastSyncError: message },
      });

      for (const syncJob of syncJobs) {
        await db.syncJob.update({
          where: { id: syncJob.id },
          data: { status: 'FAILED', completedAt: new Date(), error: message },
        });
      }

      throw err;
    }
  },
  {
    connection: createWorkerConnection(),
    concurrency: 3,
    ...workerTuning,
  }
);

worker.on('completed', job => {
  console.log(`[ScrapeWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[ScrapeWorker] Job ${job?.id} failed:`, err.message);
});

guardWorker('ScrapeWorker', worker);

export default worker;
