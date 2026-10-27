/**
 * Read an account's stored statements again from their PDFs, with the
 * current reader. A fix to how a bill is read (Republic's service-interrupt
 * memo, a fee kind added) otherwise only reached bills fetched after it;
 * the ones already on file kept the old figures. Each PDF goes back through
 * intakeBill, which finds the bill it came from and overwrites it, keeping
 * the fees logged with payments and the PDF where it is.
 */
import { db } from '../config/db';
import { downloadDocument } from './s3Service';
import { intakeBill } from './documentIntake';

const running = new Set<string>();

export const isRereading = (utilityAccountId: string) => running.has(utilityAccountId);

/** Starts the re-read in the background; returns how many statements it will read, or null if one is already running. */
export async function rereadAccountStatements(userId: string, utilityAccountId: string): Promise<number | null> {
  if (running.has(utilityAccountId)) return null;
  const account = await db.utilityAccount.findFirst({
    where: { id: utilityAccountId, property: { userId } },
    select: { id: true, accountNumber: true },
  });
  if (!account) throw Object.assign(new Error('Utility account not found'), { status: 404 });
  const rows = await db.statement.findMany({
    where: { utilityAccountId, pdfS3Key: { not: null } },
    select: { id: true, pdfS3Key: true, rawDataJson: true },
    orderBy: { statementDate: 'asc' },
  }).then(all => all.filter(r => (r.rawDataJson as any)?.source !== 'email'));   // an email printout is not a statement
  if (!rows.length) return 0;
  running.add(utilityAccountId);
  const last4 = String(account.accountNumber ?? '').replace(/\D/g, '').slice(-4);
  const batchId = `reread-${Date.now()}`;
  void (async () => {
    try {
      for (const r of rows) {
        try {
          const buf = await downloadDocument(r.pdfS3Key!);
          const name = r.pdfS3Key!.split('/').pop() || 'statement.pdf';
          const source = String((r.rawDataJson as any)?.source ?? 'pdf_import');
          await intakeBill(buf, name, userId, 'ai', batchId, source, { forAccounts: [{ id: account.id, last4 }], pdfKey: r.pdfS3Key!, statementId: r.id });
        } catch (err) {
          console.warn(`[Reread] statement ${r.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      running.delete(utilityAccountId);
    }
  })();
  return rows.length;
}
