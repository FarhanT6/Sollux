import { Router } from 'express';
import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/query', async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };
    if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

    const userId = req.dbUserId!;
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

    const [properties, loans, activeLeases, expensesThisMonth] = await Promise.all([
      db.property.findMany({
        where: { userId },
        include: {
          utilityAccounts: {
            include: {
              statements: { orderBy: { statementDate: 'desc' }, take: 1 },
              payments: {
                where: { paymentDate: { gte: startOfMonth } },
                orderBy: { paymentDate: 'desc' },
                take: 3,
              },
            },
          },
        },
      }),

      db.loan.findMany({
        where: { userId },
        include: {
          property: { select: { address: true, nickname: true } },
          loanPayments: { orderBy: { date: 'desc' }, take: 3 },
        },
        orderBy: { createdAt: 'desc' },
      }),

      db.lease.findMany({
        where: { status: 'ACTIVE', unit: { property: { userId } } },
        include: {
          leaseTenants: {
            include: { tenant: { select: { fullName: true } } },
          },
          unit: {
            include: { property: { select: { address: true, nickname: true } } },
          },
          rentPayments: {
            where: { paidDate: { gte: startOfMonth } },
            orderBy: { paidDate: 'desc' },
          },
        },
      }),

      db.expense.findMany({
        where: { userId, date: { gte: startOfMonth }, isPersonal: false },
        include: { property: { select: { address: true, nickname: true } } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const fmt = (n: unknown) =>
      n != null && !isNaN(Number(n))
        ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        : '—';

    const fmtDate = (d: Date | string | null | undefined) =>
      d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    const lines: string[] = [
      `TODAY: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `REPORTING MONTH: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
      '',
      '=== UTILITY BILLS ===',
    ];

    for (const prop of properties) {
      const name = prop.nickname || prop.address;
      for (const acct of prop.utilityAccounts) {
        const stmt = acct.statements[0];
        if (!stmt) continue;
        const amountDue = Number(stmt.amountDue ?? 0);
        const dueDate = stmt.dueDate ? new Date(stmt.dueDate) : null;
        const paid = acct.payments.length > 0 || Number(stmt.amountPaid ?? 0) > 0;
        const pastDue = !paid && dueDate && dueDate < now;
        const dueSoon = !paid && !pastDue && dueDate && dueDate <= new Date(Date.now() + 7 * 86400000);
        lines.push(
          `• ${name} — ${acct.providerName} (${acct.category}): ${fmt(amountDue)} due ${fmtDate(dueDate)} | ${paid ? 'PAID' : pastDue ? 'PAST DUE' : dueSoon ? 'DUE SOON' : 'UNPAID'}`
        );
      }
    }

    lines.push('', '=== RENT COLLECTION (this month) ===');
    for (const lease of activeLeases) {
      const tenants = lease.leaseTenants.map((lt: any) => lt.tenant.fullName).join(', ') || 'Unknown';
      const propName = (lease.unit as any).property?.nickname || (lease.unit as any).property?.address || '—';
      const paidThisMonth = lease.rentPayments.length > 0;
      const totalPaid = lease.rentPayments.reduce((s: number, p: any) => s + Number(p.amount), 0);
      const arrears = Number(lease.arrearsBalance);
      lines.push(
        `• ${propName} — ${tenants}: Rent ${fmt(lease.rentAmount)}/mo | This month: ${paidThisMonth ? `PAID (${fmt(totalPaid)})` : 'NOT PAID'} | Arrears: ${fmt(arrears)} | Lease ends: ${fmtDate(lease.endDate) || 'month-to-month'}`
      );
    }

    lines.push('', '=== LOANS ===');
    for (const loan of loans) {
      const propName = (loan.property as any)?.nickname || (loan.property as any)?.address || 'Personal';
      const lastPmt = loan.loanPayments[0];
      let maturityNote = '—';
      if (loan.maturityDate) {
        const daysLeft = Math.round((new Date(loan.maturityDate).getTime() - now.getTime()) / 86400000);
        maturityNote = `${fmtDate(loan.maturityDate)} (${daysLeft > 0 ? `${daysLeft} days away` : 'MATURED'})`;
      }
      lines.push(
        `• ${propName} — ${loan.lender} (${loan.loanType}): Balance ${fmt(loan.currentBalance ?? loan.originalAmount)} | Rate ${loan.interestRate != null ? `${Number(loan.interestRate)}%` : '—'} | Monthly ${fmt(loan.monthlyPayment)} | Maturity ${maturityNote} | Status: ${loan.isActive ? 'ACTIVE' : 'CLOSED'} | Last payment: ${lastPmt ? `${fmt(lastPmt.amount)} on ${fmtDate(lastPmt.date)}` : 'none on record'}`
      );
    }

    lines.push('', '=== EXPENSES THIS MONTH ===');
    if (expensesThisMonth.length === 0) {
      lines.push('No expenses logged this month.');
    } else {
      const grouped: Record<string, any[]> = {};
      for (const e of expensesThisMonth as any[]) {
        const k = e.property?.nickname || e.property?.address || 'General';
        grouped[k] = [...(grouped[k] || []), e];
      }
      for (const [propName, exps] of Object.entries(grouped)) {
        const total = exps.reduce((s: number, e: any) => s + Number(e.amount), 0);
        lines.push(`• ${propName}: ${exps.length} expense(s) totaling ${fmt(total)}`);
        for (const e of exps.slice(0, 5)) {
          lines.push(
            `  - ${fmtDate(e.date)} | ${e.category}${e.vendor ? ` | ${e.vendor}` : ''}${e.description ? ` | ${e.description}` : ''} | ${fmt(e.amount)}${e.isCapEx ? ' [CapEx]' : ''}`
          );
        }
        if (exps.length > 5) lines.push(`  … and ${exps.length - 5} more`);
      }
    }

    const context = lines.join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a concise property management assistant for a real estate investor.
Answer questions about their portfolio using only the data provided.
Use bullet points for lists of items. Include dollar amounts whenever relevant.
If data needed to answer isn't in the context, say so clearly.
Keep responses under 300 words unless detail is genuinely needed.`,
      messages: [{ role: 'user', content: `${context}\n\nQuestion: ${query}` }],
    });

    const answer = (message.content[0] as Anthropic.TextBlock).text;
    res.json({ answer });
  } catch (err: any) {
    console.error('AI query error:', err);
    res.status(500).json({ error: 'Failed to process query' });
  }
});

export default router;
