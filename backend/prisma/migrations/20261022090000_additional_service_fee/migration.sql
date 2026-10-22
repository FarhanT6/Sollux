-- An additional service charge (Republic Services' extra trash pickup,
-- ordered after a disconnection or for any other reason) is a fee, not
-- service. Same trigger as 20261021120000, replaced; re-run over every
-- statement.
CREATE OR REPLACE FUNCTION sollux_statement_fees() RETURNS trigger AS $$
DECLARE
  fee numeric;
  total numeric;
BEGIN
  IF NEW."rawDataJson" IS NULL OR jsonb_typeof(NEW."rawDataJson"->'chargeBreakdown') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT
    COALESCE(sum(v::numeric) FILTER (WHERE k ~* '(late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|disconnect|contaminat|collection fee|additional (service|pick[- ]?up)|extra (service|pick[- ]?up))'), 0),
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
