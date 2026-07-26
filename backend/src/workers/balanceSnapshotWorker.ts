import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { syncBalancesForItem } from '../routes/plaid';

export async function runDailyBalanceSnapshot() {
  console.log('[BalanceSnapshot] Starting nightly balance sync for all users');

  const items = await db.plaidItem.findMany({ where: { isActive: true } });
  let synced = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const accessToken = decrypt(item.accessTokenEnc);
      await syncBalancesForItem(item.id, accessToken);
      synced++;
    } catch (err: any) {
      failed++;
      console.error(`[BalanceSnapshot] Failed for item ${item.id} (${item.institutionName}):`, err.message);
    }
  }

  console.log(`[BalanceSnapshot] Done — ${synced} synced, ${failed} failed`);
}
