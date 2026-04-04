import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANOMALY_THRESHOLD = 0.20; // 20% deviation from average triggers anomaly
const MIN_STATEMENTS_FOR_ANALYSIS = 3;

/**
 * Run the full insight generation pipeline for a property.
 */
export async function generateInsightsForProperty(propertyId: string): Promise<void> {
  const property = await db.property.findUnique({
    where: { id: propertyId },
    include: {
      utilityAccounts: {
        where: { syncEnabled: true },
        include: {
          statements: {
            orderBy: { statementDate: 'desc' },
            take: 12,
          },
        },
      },
    },
  });

  if (!property) return;

  for (const account of property.utilityAccounts) {
    await generateInsightsForAccount(property.id, account);
  }

  // Generate due-date reminders across the property
  await generateDueDateReminders(property.id);
}

async function generateInsightsForAccount(
  propertyId: string,
  account: any
): Promise<void> {
  const statements = account.statements;
  if (statements.length < MIN_STATEMENTS_FOR_ANALYSIS) return;

  const amounts = statements
    .map((s: any) => Number(s.amountDue))
    .filter((a: number) => a > 0);

  if (amounts.length < MIN_STATEMENTS_FOR_ANALYSIS) return;

  // Calculate rolling 3-month average
  const recentAvg = amounts.slice(1, 4).reduce((s: number, a: number) => s + a, 0) / 3;
  const current = amounts[0];
  const deviation = (current - recentAvg) / recentAvg;

  // ── Anomaly detection ──────────────────────────────────────
  if (Math.abs(deviation) >= ANOMALY_THRESHOLD) {
    const direction = deviation > 0 ? 'higher' : 'lower';
    const pct = Math.abs(Math.round(deviation * 100));

    // Check if this anomaly insight already exists recently
    const existing = await db.aIInsight.findFirst({
      where: {
        utilityAccountId: account.id,
        insightType: 'ANOMALY',
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });

    if (!existing) {
      // Use Claude to generate natural language insight
      const aiBody = await callClaudeForInsight({
        type: 'anomaly',
        providerName: account.providerName,
        category: account.category,
        currentAmount: current,
        averageAmount: recentAvg,
        deviation: pct,
        direction,
        recentAmounts: amounts.slice(0, 6),
      });

      await db.aIInsight.create({
        data: {
          propertyId,
          utilityAccountId: account.id,
          insightType: 'ANOMALY',
          severity: pct >= 40 ? 'ALERT' : 'WARNING',
          title: `${account.providerName} bill ${pct}% ${direction} than usual`,
          body: aiBody.body,
          recommendation: aiBody.recommendation,
          potentialSavings: deviation < 0 ? recentAvg - current : undefined,
        },
      });
    }
  }

  // ── Savings opportunity detection ──────────────────────────
  if (account.category === 'ELECTRIC' && recentAvg > 150) {
    const existing = await db.aIInsight.findFirst({
      where: {
        utilityAccountId: account.id,
        insightType: 'SAVINGS',
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });

    if (!existing) {
      const aiBody = await callClaudeForInsight({
        type: 'savings',
        providerName: account.providerName,
        category: account.category,
        currentAmount: current,
        averageAmount: recentAvg,
      });

      await db.aIInsight.create({
        data: {
          propertyId,
          utilityAccountId: account.id,
          insightType: 'SAVINGS',
          severity: 'INFO',
          title: `Potential savings opportunity — ${account.providerName}`,
          body: aiBody.body,
          recommendation: aiBody.recommendation,
          potentialSavings: aiBody.estimatedSavings,
        },
      });
    }
  }
}

async function generateDueDateReminders(propertyId: string): Promise<void> {
  const sevenDaysFromNow = new Date();
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

  const upcomingBills = await db.statement.findMany({
    where: {
      utilityAccount: { propertyId },
      dueDate: { gte: new Date(), lte: sevenDaysFromNow },
      amountPaid: null,
    },
    include: {
      utilityAccount: { select: { id: true, providerName: true } },
    },
  });

  for (const bill of upcomingBills) {
    const daysUntilDue = Math.ceil(
      (bill.dueDate!.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    const existing = await db.aIInsight.findFirst({
      where: {
        utilityAccountId: bill.utilityAccount.id,
        insightType: 'REMINDER',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!existing) {
      await db.aIInsight.create({
        data: {
          propertyId,
          utilityAccountId: bill.utilityAccount.id,
          insightType: 'REMINDER',
          severity: daysUntilDue <= 2 ? 'ALERT' : 'WARNING',
          title: `${bill.utilityAccount.providerName} due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`,
          body: `Your ${bill.utilityAccount.providerName} bill of $${Number(bill.amountDue).toFixed(2)} is due on ${bill.dueDate!.toLocaleDateString()}.`,
          recommendation: 'Set up autopay to avoid late fees.',
        },
      });
    }
  }
}

interface ClaudeInsightRequest {
  type: 'anomaly' | 'savings';
  providerName: string;
  category: string;
  currentAmount: number;
  averageAmount: number;
  deviation?: number;
  direction?: string;
  recentAmounts?: number[];
  estimatedSavings?: number;
}

interface ClaudeInsightResponse {
  body: string;
  recommendation: string;
  estimatedSavings?: number;
}

async function callClaudeForInsight(data: ClaudeInsightRequest): Promise<ClaudeInsightResponse> {
  try {
    const prompt = data.type === 'anomaly'
      ? `You are an AI assistant for Sollux, a property utility management app. 
         
         A user's ${data.providerName} ${data.category.toLowerCase()} bill is ${data.deviation}% ${data.direction} than their 3-month average.
         Current bill: $${data.currentAmount.toFixed(2)}
         3-month average: $${data.averageAmount.toFixed(2)}
         Recent amounts: ${data.recentAmounts?.map(a => `$${a.toFixed(2)}`).join(', ')}
         
         Write a concise, helpful insight (2-3 sentences) explaining possible reasons and what to check.
         Then write a short recommendation (1 sentence).
         
         Respond in JSON: { "body": "...", "recommendation": "..." }`
      : `You are an AI assistant for Sollux, a property utility management app.
         
         A user's average ${data.providerName} ${data.category.toLowerCase()} bill is $${data.averageAmount.toFixed(2)}/month.
         Write a concise savings tip (2-3 sentences) specific to this utility type.
         Include an estimated annual savings if they follow the recommendation.
         
         Respond in JSON: { "body": "...", "recommendation": "...", "estimatedSavings": <number> }`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    return parsed;
  } catch (err) {
    // Fallback to template response if Claude call fails
    console.error('[InsightEngine] Claude API error:', err);
    return {
      body: `Your ${data.providerName} bill has changed from your recent average. Review your account for any changes in usage or billing.`,
      recommendation: 'Log in to your utility account to review recent usage and any new charges.',
    };
  }
}
