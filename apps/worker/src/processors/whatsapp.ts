import { WhatsappInboundJob } from "@platform/shared";
import { Job } from "bullmq";
import type pino from "pino";

// Example dependencies you might pass in from main.ts
type WhatsappDeps = {
  prisma: any;
  // you might also need an AI completion service here
};

export function whatsappProcessor(deps: WhatsappDeps, logger: pino.Logger) {
  return async (job: Job<WhatsappInboundJob>): Promise<void> => {
    const data = job.data;
    logger.info({ sessionId: data.sessionId, messageId: data.messageId }, "Processing inbound WhatsApp message");

    // 1. Fetch ChatSession and recent ChatMessages
    const session = await deps.prisma.chatSession.findUnique({
      where: { id: data.sessionId },
      include: {
        agent: true,
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!session || !session.agentId) {
      logger.warn("ChatSession not found or has no agent assigned");
      return;
    }

    // 2. Fetch Agent Configuration (Prompt, persona, tools)
    const agentVersion = await deps.prisma.agentVersion.findFirst({
      where: { agentId: session.agentId, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });

    if (!agentVersion) {
      logger.warn("Agent has no published version");
      return;
    }

    // 3. Prepare Chat History for LLM
    // Map messages to LLM format (system, user, assistant)

    // 4. Call LLM (e.g. Gemini/OpenAI) using @platform/ai
    // const aiResponse = await deps.ai.complete(prompt, history);

    // 5. Save the generated AI response to ChatMessage table
    /*
    const outMessage = await deps.prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        direction: "OUTBOUND",
        type: "TEXT",
        content: aiResponse.text,
      }
    });
    */

    // 6. Send the message back via Meta Graph API
    // fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, { ... })
    
    // 7. Execute any tools returned by LLM (e.g. whatsapp.send_document)

    logger.info("Processed WhatsApp message successfully");
  };
}
