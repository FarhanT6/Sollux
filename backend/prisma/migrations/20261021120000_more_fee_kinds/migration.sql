-- Fees are more than late fees: contamination charges (Republic Services'
-- "Contaminated Materials"), delinquent charges (Rincon's "Delinquent
-- Charge") and disconnection / reconnection charges are penalties too, not
-- service. Everything else on a bill stays a service charge.
-- And a bill that already had one fee recorded (Republic's $9.79 late fee)
-- did not take in the others: penalties now rise to the charge list's fee
-- total whenever that is higher. Same trigger as 20261021090000, replaced.
CREATE OR REPLACE FUNCTION sollux_statement_fees() RETURNS trigger AS $$
DECLARE
  fee numeric;
  total numeric;
BEGIN
  IF NEW."rawDataJson" IS NULL OR jsonb_typeof(NEW."rawDataJson"->'chargeBreakdown') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT
    COALESCE(sum(v::numeric) FILTER (WHERE k ~* '(late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|disconnect|contaminat|collection fee)'), 0),
    COALESCE(sum(v::numeric), 0)
  INTO fee, total
  FROM jsonb_each_text(NEW."rawDataJson"->'chargeBreakdown') AS e(k, v)
  WHERE v ~ '^-?[0-9]+(\.[0-9]+)?$';
  IF fee <= 0.005 THEN
    RETURN NEW;
  END IF;
  IF NEW."penaltiesFees" IS NULL OR NEW."penaltiesFees" < round(fee, 2) - 0.005 THEN
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

UPDATE "statements" SET "rawDataJson" = "rawDataJson"
WHERE jsonb_typeof("rawDataJson"->'chargeBreakdown') = 'object';
