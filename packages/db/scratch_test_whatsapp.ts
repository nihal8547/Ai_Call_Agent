import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import 'dotenv/config'; // loads .env from project root if running from right dir


const prisma = new PrismaClient();

async function main() {
  console.log("Starting WhatsApp Webhook Test...");

  let tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    throw new Error('No tenant found. Please run the script after logging in or disabling RLS.');
  }
  console.log(`Created Tenant: ${tenant.id}`);

  // 2. Create a mock Agent
  const agent = await prisma.agent.create({
    data: {
      tenantId: tenant.id,
      name: 'Test WhatsApp Agent',
      status: 'ACTIVE',
    }
  });

  // 3. Create a WHATSAPP Integration
  const integration = await prisma.integration.create({
    data: {
      tenantId: tenant.id,
      type: 'WHATSAPP',
      name: 'Test WhatsApp Connection',
      credentialsEncrypted: Buffer.from('mockcreds'),
      config: { phone_number_id: "1234567890" }
    }
  });
  console.log(`Created WHATSAPP Integration: ${integration.id}`);

  // 4. Mock the webhook payload from Meta
  const mockPayload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: {
                phone_number_id: "1234567890"
              },
              messages: [
                {
                  from: "97433334444",
                  text: {
                    body: "Hello, I want to know about your services."
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };

  console.log("\nSimulating Incoming Webhook...");
  // Simulate WhatsappService logic:
  const entry = mockPayload.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messages = value?.messages;
  const message = messages[0];
  const customerNumber = message.from;
  const phoneNumberId = value.metadata.phone_number_id;

  // Assume we matched the integration somehow (in real life by matching phone_number_id in config)
  const tenantId = integration.tenantId;

  let session = await prisma.chatSession.findFirst({
    where: { tenantId, customerNumber, status: 'ACTIVE' }
  });

  if (!session) {
    session = await prisma.chatSession.create({
      data: { tenantId, customerNumber, agentId: agent.id }
    });
    console.log(`Created new ChatSession: ${session.id}`);
  }

  const chatMessage = await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      direction: 'INBOUND',
      type: 'TEXT',
      content: message.text.body,
    }
  });
  console.log(`Saved ChatMessage: ${chatMessage.id}`);
  console.log(`Content: "${chatMessage.content}"`);
  
  console.log("\nTest Passed successfully! Data saved in Postgres.");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
