import { Worker, Job } from 'bullmq';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { getScraperProvider } from '../scrapers/base';
import { uploadDocument, buildStatementKey } from '../services/s3Service';
import { insightQueue, redisConnection } from './queues';

interface ScrapeJobData {
  utilityAccountId: string;
}

const worker = new Worker<ScrapeJobData>(
  'scrape',
  async (job: Job<ScrapeJobData>) => {
    const { utilityAccountId } = job.data;
    console.log(`[ScrapeWorker] Starting job for account ${utilityAccountId}`);

    // Fetch account with encrypted credentials
    const account = await db.utilityAccount.findUnique({
      where: { id: utilityAccountId },
      include: { property: { select: { id: true, userId: true } } },
    });

    if (!account) throw new Error(`Utility account ${utilityAccountId} not found`);
    if (!account.syncEnabled) {
      console.log(`[ScrapeWorker] Sync disabled for ${utilityAccountId}, skipping`);
      return;
    }

    // Update sync status to pending
    await db.utilityAccount.update({
      where: { id: utilityAccountId },
      data: { lastSyncStatus: 'PENDING' },
    });

    // Log sync job
    const syncJob = await db.syncJob.create({
      data: { utilityAccountId, status: 'PENDING', startedAt: new Date() },
    });

    try {
      // Get scraper for this provider
      const scraper = getScraperProvider(account.providerSlug);
      if (!scraper) {
        throw new Error(`No scraper found for provider: ${account.providerSlug}`);
      }

      // Decrypt credentials — only in memory, never logged
      const credentials = {
        username: account.usernameEnc ? decrypt(account.usernameEnc) : '',
        password: account.passwordEnc ? decrypt(account.passwordEnc) : '',
        accountNumber: account.accountNumberEnc ? decrypt(account.accountNumberEnc) : undefined,
        loginUrl: account.loginUrl || undefined,
      };

      // Run scraper
      const result = await scraper.run(credentials);

      if (!result.success) {
        throw new Error(result.error || 'Scraper returned failure');
      }

      let statementsInserted = 0;
      let paymentsInserted = 0;

      // Upsert statements
      for (const stmt of result.statements) {
        // Upload PDF if present
        let pdfS3Key: string | undefined;
        if (stmt.pdfBuffer && stmt.pdfFilename) {
          const key = buildStatementKey(
            account.property.userId,
            account.property.id,
            account.id,
            stmt.statementDate,
            stmt.pdfFilename
          );
          pdfS3Key = await uploadDocument(key, stmt.pdfBuffer);
        }

        // Check if statement already exists (by date)
        const existing = await db.statement.findFirst({
          where: {
            utilityAccountId,
            statementDate: stmt.statementDate,
          },
        });

        if (!existing) {
          await db.statement.create({
            data: {
              utilityAccountId,
              statementDate: stmt.statementDate,
              dueDate: stmt.dueDate,
              billingPeriodStart: stmt.billingPeriodStart,
              billingPeriodEnd: stmt.billingPeriodEnd,
              amountDue: stmt.amountDue,
              usageValue: stmt.usageValue,
              usageUnit: stmt.usageUnit,
              ratePlan: stmt.ratePlan,
              pdfS3Key,
              rawDataJson: stmt.rawData,
            },
          });
          statementsInserted++;
        }
      }

      // Upsert payments
      for (const pmt of result.payments) {
        const existing = await db.payment.findFirst({
          where: {
            utilityAccountId,
            paymentDate: pmt.paymentDate,
            amount: pmt.amount,
          },
        });

        if (!existing) {
          await db.payment.create({
            data: {
              utilityAccountId,
              amount: pmt.amount,
              paymentDate: pmt.paymentDate,
              confirmationNumber: pmt.confirmationNumber,
              paymentMethod: pmt.paymentMethod,
              status: 'PAID',
            },
          });
          paymentsInserted++;
        }
      }

      // Update account sync status
      await db.utilityAccount.update({
        where: { id: utilityAccountId },
        data: { lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null },
      });

      // Update sync job
      await db.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'SUCCESS',
          completedAt: new Date(),
          statementsFound: statementsInserted,
          paymentsFound: paymentsInserted,
        },
      });

      // Queue insight generation for this property
      await insightQueue.add('generate', { propertyId: account.property.id }, {
        delay: 2000,
        attempts: 2,
      });

      console.log(`[ScrapeWorker] Done: ${statementsInserted} statements, ${paymentsInserted} payments`);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[ScrapeWorker] Error for ${utilityAccountId}:`, message);

      await db.utilityAccount.update({
        where: { id: utilityAccountId },
        data: { lastSyncStatus: 'FAILED', lastSyncError: message },
      });

      await db.syncJob.update({
        where: { id: syncJob.id },
        data: { status: 'FAILED', completedAt: new Date(), error: message },
      });

      throw err; // Let BullMQ handle retry
    }
  },
  {
    connection: redisConnection,
    concurrency: 3, // Max 3 scrapes at once
  }
);

worker.on('completed', job => {
  console.log(`[ScrapeWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[ScrapeWorker] Job ${job?.id} failed:`, err.message);
});

export default worker;
