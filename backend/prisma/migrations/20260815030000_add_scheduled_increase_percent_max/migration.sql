-- AlterTable: percent range upper bound for scheduled rent increases
ALTER TABLE "scheduled_rent_increases" ADD COLUMN "percentMax" DOUBLE PRECISION;
