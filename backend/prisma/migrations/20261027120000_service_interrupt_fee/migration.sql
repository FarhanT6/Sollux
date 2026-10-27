-- Republic Services prints a charge put on the account outside the invoice's
-- own list under Payments/Adjustments ("Unreferenced Memo $35.00 / Re:
-- Service Interrupt"). The reader now files it as a "Service Interrupt
-- charge" line on that month's bill; a service interrupt counts as a fee
-- (disconnection / reconnection) from now on.
CREATE OR REPLACE FUNCTION sollux_statement_fees() RETURNS trigger AS $$
DECLARE
  fee numeric;
  total numeric;
BEGIN
  IF NEW."rawDataJson" IS NULL OR jsonb_typeof(NEW."rawDataJson"->'chargeBreakdown') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT
    COALESCE(sum(v::numeric) FILTER (WHERE k ~* '(late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|disconnect|interrupt|contaminat|collection fee|additional (service|pick[- ]?up)|extra (service|pick[- ]?up)|incidental)'), 0),
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
