-- EDCO and other haulers bill once every two months. Without a value for that
-- cadence the account had to be filed as MONTHLY, which doubles its monthly
-- equivalent, or QUARTERLY, which understates it by a third.
ALTER TYPE "BillingCadence" ADD VALUE IF NOT EXISTS 'BIMONTHLY';
