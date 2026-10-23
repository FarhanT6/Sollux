-- AmTrust's Policy Installments list each installment by the date it is
-- invoiced (Installment 6 of 9: 8/3/2026), not when it is due (the Aug 3
-- bill is due Aug 23). Read as due dates, no real bill matched its
-- scheduled row, and every month showed twice: "Aug 2026 · Scheduled
-- $234.90" beside the Aug 3 bill. A scheduled row goes into the real bill
-- issued on its date (within 3 days) when that bill falls due at least 10
-- days later and asks for at least the installment — and only on accounts
-- where that happens at least twice, so a schedule of real due dates is
-- left alone. Payments logged against the scheduled row move to the bill.
CREATE TEMP TABLE sched_pairs ON COMMIT DROP AS
SELECT DISTINCT ON (s.id) s.id AS sched_id, r.id AS real_id, s."utilityAccountId" AS account_id
FROM "statements" s
JOIN "statements" r
  ON r."utilityAccountId" = s."utilityAccountId"
 AND r."isScheduled" = false AND r."isDownPayment" = false
 AND r."statementDate" BETWEEN s."dueDate" - interval '3 days' AND s."dueDate" + interval '3 days'
 AND r."dueDate" >= s."dueDate" + interval '10 days'
 AND s."amountDue" <= r."amountDue" + 0.05
WHERE s."isScheduled" = true AND s."dueDate" IS NOT NULL
ORDER BY s.id, abs(extract(epoch FROM (r."statementDate" - s."dueDate")));

DELETE FROM sched_pairs WHERE account_id IN (
  SELECT account_id FROM sched_pairs GROUP BY account_id HAVING count(*) < 2
);

UPDATE "payments" p SET "statementId" = sp.real_id
FROM sched_pairs sp WHERE p."statementId" = sp.sched_id;

DELETE FROM "statements" s USING sched_pairs sp WHERE s.id = sp.sched_id;
