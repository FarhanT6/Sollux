-- A bill's fees, its total and its charge list must agree, whichever path
-- wrote it (import, portal fetch, email, a lender's ledger, a hand edit).
-- Capital Premium Financing's Oct installment listed Principal 535.32 +
-- Interest 79.70 + Late Fee 30.75 = 645.77, yet was stored at 615.02 with no
-- penalties, so the Fees tab, the balance and the payment's "Applied to" line
-- all missed the late fee. On every insert or update of a statement:
--   1. fee lines in the charge list (late / penalty / NSF / returned payment /
--      delinquent / reconnect / collection) fill penaltiesFees when it is empty;
--   2. when the stored charge is exactly the list's total less those fees, the
--      charge becomes the list's total (and the balance with it, when it was
--      the same figure).
-- Bills that already agree are left alone; a fee logged with a payment
-- (lateFees.ts) writes all three together and is not touched.
CREATE OR REPLACE FUNCTION sollux_statement_fees() RETURNS trigger AS $$
DECLARE
  fee numeric;
  total numeric;
BEGIN
  IF NEW."rawDataJson" IS NULL OR jsonb_typeof(NEW."rawDataJson"->'chargeBreakdown') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT
    COALESCE(sum(v::numeric) FILTER (WHERE k ~* '(late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|collection fee|disconnect(ion)? fee)'), 0),
    COALESCE(sum(v::numeric), 0)
  INTO fee, total
  FROM jsonb_each_text(NEW."rawDataJson"->'chargeBreakdown') AS e(k, v)
  WHERE v ~ '^-?[0-9]+(\.[0-9]+)?$';
  IF fee <= 0.005 THEN
    RETURN NEW;
  END IF;
  IF NEW."penaltiesFees" IS NULL OR NEW."penaltiesFees" = 0 THEN
    NEW."penaltiesFees" := round(fee, 2);
  END IF;
  IF NEW."amountDue" IS NOT NULL AND abs(NEW."amountDue" + fee - total) < 0.01 THEN
    IF NEW."balance" IS NOT NULL AND abs(NEW."balance" - NEW."amountDue") < 0.01 THEN
      NEW."balance" := round(total, 2);
    END IF;
    NEW."amountDue" := round(total, 2);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statements_fees_from_breakdown ON "statements";
CREATE TRIGGER statements_fees_from_breakdown
  BEFORE INSERT OR UPDATE ON "statements"
  FOR EACH ROW EXECUTE FUNCTION sollux_statement_fees();

-- Bring the bills already on file into line (the trigger does the work).
UPDATE "statements" SET "rawDataJson" = "rawDataJson"
WHERE jsonb_typeof("rawDataJson"->'chargeBreakdown') = 'object';
