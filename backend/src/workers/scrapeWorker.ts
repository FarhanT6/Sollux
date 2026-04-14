import { Worker, Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { getScraperProvider } from '../scrapers/registry';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { insightQueue, redisConnection } from './queues';

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

      // Find the most recent statement that already has a PDF stored.
      // Statements without a PDF are re-scraped so we can download the PDF.
      // This means: first run always fetches all PDFs; future runs skip dates already downloaded.
      const latestStmt = await db.statement.findFirst({
        where: {
          utilityAccountId: { in: sameCredAccounts.map(a => a.id) },
          pdfS3Key: { not: null },   // only count statements where PDF was actually stored
        },
        orderBy: { statementDate: 'desc' },
        select: { statementDate: true },
      });
      const latestStatementDate = latestStmt?.statementDate ?? undefined;

      const credentials = { username, password, accountNumbers, latestStatementDate };
      const result = await scraper.run(credentials, utilityAccountId);

      if (!result.success) throw new Error(result.error || 'Scraper returned failure');

      // ── Distribute statements to the correct utility account by account number ──
      let totalInserted = 0;

      for (const acct of sameCredAccounts) {
        const acctNum = acct.accountNumberEnc ? decrypt(acct.accountNumberEnc) : null;
        let statementsInserted = 0;
        let paymentsInserted = 0;

        // Match statements to this utility account
        const matchingStmts = acctNum
          ? result.statements.filter(stmt => {
              const stmtAcctNum = stmt.rawData?.accountNumber as string | undefined;
              if (!stmtAcctNum) return sameCredAccounts.length === 1; // single-account: take all
              const a = normalizeAcct(stmtAcctNum);
              const b = normalizeAcct(acctNum);
              return a === b || a.includes(b) || b.includes(a);
            })
          : result.statements; // no account number stored — take all (single account case)

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

          // Check for exact date match first, then same-month match (catches account summary
          // rows that arrive with today's date instead of the real statement date)
          const monthStart = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth(), 1);
          const monthEnd = new Date(stmt.statementDate.getFullYear(), stmt.statementDate.getMonth() + 1, 0, 23, 59, 59);
          const existing = await db.statement.findFirst({
            where: { utilityAccountId: acct.id, statementDate: { gte: monthStart, lte: monthEnd } },
            orderBy: { createdAt: 'asc' }, // prefer the oldest (first scraped = real statement)
          });

          const isPaid = stmt.rawData?.isPaid === true;
          const amountPaid = isPaid && stmt.amountDue ? stmt.amountDue : undefined;

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
            // Update existing statement if paid status has changed or rawData has new info.
            // This handles the case where a user pays a past-due bill between syncs.
            const wasUnpaid = !existing.amountPaid;
            const rawChanged = JSON.stringify(existing.rawDataJson) !== JSON.stringify(stmt.rawData);
            if ((isPaid && wasUnpaid) || rawChanged) {
              await db.statement.update({
                where: { id: existing.id },
                data: {
                  ...(isPaid && wasUnpaid ? { amountPaid } : {}),
                  rawDataJson: stmt.rawData as Prisma.InputJsonValue,
                  // Also update dueDate/amounts in case scraper got better data on re-scrape
                  ...(stmt.dueDate ? { dueDate: stmt.dueDate } : {}),
                  ...(stmt.amountDue ? { amountDue: stmt.amountDue } : {}),
                },
              });
            }
          }
        }

        // Payments — only assign to the triggering account (payments aren't account-specific in WM)
        if (acct.id === utilityAccountId) {
          for (const pmt of result.payments) {
            const existing = await db.payment.findFirst({
              where: { utilityAccountId: acct.id, paymentDate: pmt.paymentDate, amount: pmt.amount },
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
    connection: redisConnection,
    concurrency: 3,
  }
);

worker.on('completed', job => {
  console.log(`[ScrapeWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[ScrapeWorker] Job ${job?.id} failed:`, err.message);
});

export default worker;
