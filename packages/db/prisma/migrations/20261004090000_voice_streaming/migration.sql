-- Streaming voice (Twilio ConversationRelay) is metered per minute
ALTER TYPE "UsageKind" ADD VALUE 'VOICE_STREAMING_MINUTES';
