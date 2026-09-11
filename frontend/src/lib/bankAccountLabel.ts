import type { BankAccount } from '../types';

/**
 * One line that says which account or card this is and whose: "Chase
 * Sapphire · Visa ••4093 · Farhan". The same string wherever a payment
 * source is picked or shown, so a card is never mistaken for a checking
 * account with the same last four.
 */
export function bankAccountLabel(b: Pick<BankAccount, 'name' | 'last4' | 'bank' | 'accountType'> & { ownerLabel?: string | null; cardNetwork?: string | null; cardExpiry?: string | null }): string {
  const isCard = b.accountType === 'CREDIT_CARD' || b.accountType === 'DEBIT_CARD';
  const parts = [b.name];
  const id = [isCard ? (b.cardNetwork || (b.accountType === 'CREDIT_CARD' ? 'Credit' : 'Debit')) : null, b.last4 ? `••${b.last4}` : null].filter(Boolean).join(' ');
  if (id) parts.push(id);
  if (b.ownerLabel) parts.push(b.ownerLabel);
  return parts.join(' · ');
}
