import { useEffect, useState } from 'react';
import type { BankAccount } from '../../types';
import { getBankAccounts, createBankAccount } from '../../api/client';
import { bankAccountLabel } from '../../lib/bankAccountLabel';

/**
 * Which of the owner's accounts or cards a payment came from. Paying by
 * card lists the cards on file and offers to add one right here (name,
 * network, last four, expiry — never the number); anything else lists bank
 * accounts first. `resolve()` returns the id to store, creating the new
 * card first when one was typed in.
 */
export const NEW_CARD = '__new_card__';

export interface NewCardForm { name: string; cardNetwork: string; last4: string; cardExpiry: string; accountType: 'CREDIT_CARD' | 'DEBIT_CARD' }
export const emptyNewCard: NewCardForm = { name: '', cardNetwork: 'Visa', last4: '', cardExpiry: '', accountType: 'CREDIT_CARD' };

export function useBankAccounts() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  useEffect(() => { getBankAccounts().then(bs => setAccounts(bs.filter(b => b.isActive))).catch(() => {}); }, []);
  return [accounts, setAccounts] as const;
}

/** The bank account id to store; creates the typed-in card when chosen. Throws with a readable message. */
export async function resolvePaymentSource(selected: string, card: NewCardForm, onCreated?: (b: BankAccount) => void): Promise<string | null> {
  if (selected !== NEW_CARD) return selected || null;
  if (!card.name.trim() || !/^\d{4}$/.test(card.last4)) throw new Error('Give the card a name and its last four digits.');
  const created = await createBankAccount({
    name: card.name.trim(), last4: card.last4, cardNetwork: card.cardNetwork || null,
    cardExpiry: card.cardExpiry.trim() || null, accountType: card.accountType, bank: card.cardNetwork || undefined,
  });
  onCreated?.(created);
  return created.id;
}

const isCard = (b: BankAccount) => b.accountType === 'CREDIT_CARD' || b.accountType === 'DEBIT_CARD';

export default function PaymentSourcePicker({ accounts, paymentMethod, value, onChange, card, onCardChange, className = '', inputClass = 'input-dark text-xs' }: {
  accounts: BankAccount[];
  paymentMethod: string;
  value: string;
  onChange: (id: string) => void;
  card: NewCardForm;
  onCardChange: (c: NewCardForm) => void;
  className?: string;
  inputClass?: string;
}) {
  const byCard = paymentMethod === 'Card';
  const listed = byCard ? accounts.filter(isCard) : [...accounts.filter(b => !isCard(b)), ...accounts.filter(isCard)];
  return (
    <div className={className}>
      <select value={value} onChange={e => onChange(e.target.value)} className={`${inputClass} w-full`}>
        <option value="">{byCard ? '— Which card? —' : '— Paid from which account? —'}</option>
        {listed.map(b => <option key={b.id} value={b.id}>{bankAccountLabel(b)}</option>)}
        <option value={NEW_CARD}>+ Add a new card…</option>
      </select>
      {value === NEW_CARD && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input value={card.name} onChange={e => onCardChange({ ...card, name: e.target.value })} placeholder="Card name (Chase Sapphire) *" className={`${inputClass} col-span-2`} />
          <select value={card.cardNetwork} onChange={e => onCardChange({ ...card, cardNetwork: e.target.value })} className={inputClass}>
            {['Visa', 'Mastercard', 'Amex', 'Discover', 'Other'].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <select value={card.accountType} onChange={e => onCardChange({ ...card, accountType: e.target.value as 'CREDIT_CARD' | 'DEBIT_CARD' })} className={inputClass}>
            <option value="CREDIT_CARD">Credit card</option>
            <option value="DEBIT_CARD">Debit card</option>
          </select>
          <input value={card.last4} onChange={e => onCardChange({ ...card, last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} placeholder="Last 4 digits *" inputMode="numeric" className={inputClass} />
          <input value={card.cardExpiry} onChange={e => onCardChange({ ...card, cardExpiry: e.target.value })} placeholder="Expiry MM/YY" className={inputClass} />
          <p className="text-xs text-gray-600 col-span-2">Only the last four digits are kept. The card is saved to your accounts for next time.</p>
        </div>
      )}
    </div>
  );
}
