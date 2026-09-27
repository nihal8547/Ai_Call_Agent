-- New businesses default to Qatar (existing businesses keep their settings)
ALTER TABLE "tenants" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Qatar',
ALTER COLUMN "calling_code" SET DEFAULT '974',
ALTER COLUMN "country" SET DEFAULT 'QA',
ALTER COLUMN "currency" SET DEFAULT 'QAR';
