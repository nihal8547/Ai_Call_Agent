-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'WHATSAPP_MESSAGES';


-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "conversation_id" UUID;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "agent_handled_at" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Appointments booked in chats are found by their conversation (dedupe, "cancel my booking")
CREATE INDEX "appointments_conversation_id_idx" ON "appointments"("conversation_id");
