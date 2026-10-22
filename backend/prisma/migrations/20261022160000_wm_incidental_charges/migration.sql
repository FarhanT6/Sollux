-- Waste Management, Aug 2026: the bill was read as $109.23 when WM's
-- Invoice History said Incidental Charges $109.23 | Current Invoice Charges
-- $374.38. The retired WM connector took the first dollar figure in the row
-- as the bill; on a month with incidental charges that is the incidental
-- figure, and the current invoice charges (which include it) were lost.
-- Rows it saved keep that row's text (rawDataJson.rawText, "… $109.23 View
-- $374.38 …"): the bill is the figure after "View", the incidental charge a
-- fee within it. Only rows still holding the incidental figure are changed.
-- And incidental charges count as fees from now on (trigger regex).
CREATE OR REPLACE FUNCTION sollux_statement_fees() RETURNS trigger AS $$
DECLARE
  fee numeric;
  total numeric;
BEGIN
  IF NEW."rawDataJson" IS NULL OR jsonb_typeof(NEW."rawDataJson"->'chargeBreakdown') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT
    COALESCE(sum(v::numeric) FILTER (WHERE k ~* '(late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|disconnect|contaminat|collection fee|additional (service|pick[- ]?up)|extra (service|pick[- ]?up)|incidental)'), 0),
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


WITH w AS (
  SELECT s.id, s."amountDue" AS old,
    replace((regexp_match(s."rawDataJson"->>'rawText', '\$\s*([0-9,]+\.[0-9]{2})\s*View', 'i'))[1], ',', '')::numeric AS inc,
    replace((regexp_match(s."rawDataJson"->>'rawText', '\$\s*[0-9,]+\.[0-9]{2}\s*View\s*\$\s*([0-9,]+\.[0-9]{2})', 'i'))[1], ',', '')::numeric AS cur
  FROM "statements" s
  WHERE s."rawDataJson"->>'rawText' ~* '\$\s*[0-9,]+\.[0-9]{2}\s*View\s*\$\s*[0-9,]+\.[0-9]{2}'
)
UPDATE "statements" s
SET "amountDue" = w.cur,
    "balance" = CASE WHEN s."balance" IS NULL THEN NULL ELSE round(s."balance" + (w.cur - w.old), 2) END,
    "chargesExcludingFees" = round(w.cur - w.inc, 2),
    "penaltiesFees" = GREATEST(COALESCE(s."penaltiesFees", 0), w.inc),
    "rawDataJson" = CASE
      WHEN jsonb_typeof(s."rawDataJson"->'chargeBreakdown') = 'object' THEN s."rawDataJson"
      ELSE jsonb_set(s."rawDataJson", '{chargeBreakdown}', jsonb_build_object('Regular service', round(w.cur - w.inc, 2), 'Incidental charges', w.inc))
    END || jsonb_build_object('incidentalCharges', w.inc, 'readAsIncidental', w.old)
FROM w
WHERE s.id = w.id AND w.inc IS NOT NULL AND w.cur IS NOT NULL AND w.cur > w.inc
  AND s."amountDue" IS NOT NULL AND abs(s."amountDue" - w.inc) < 0.01;

UPDATE "statements" SET "rawDataJson" = "rawDataJson"
WHERE jsonb_typeof("rawDataJson"->'chargeBreakdown') = 'object';
