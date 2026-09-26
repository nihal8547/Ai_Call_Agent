-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "integration_id" UUID;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
