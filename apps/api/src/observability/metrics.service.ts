import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { QUEUES } from "@platform/shared";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { QueueService } from "../infra/queue.service";

/**
 * Prometheus metrics for the API: HTTP, calls, turns, fallbacks, tools, knowledge answers, queues
 * and cost. Label values are small fixed sets (never tenant ids, numbers or text), so series stay few.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  readonly http = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP requests by route and status class",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  readonly calls = new Counter({
    name: "voice_calls_total",
    help: "Inbound calls by how they arrived and what happened before answering",
    labelNames: ["connection", "result"] as const,
    registers: [this.registry],
  });
  readonly turn = new Histogram({
    name: "voice_turn_duration_seconds",
    help: "Time to produce the agent's reply on the webhook path",
    labelNames: ["ai"] as const,
    buckets: [0.1, 0.25, 0.5, 0.75, 1, 1.2, 1.5, 2, 3, 5],
    registers: [this.registry],
  });
  readonly turns = new Counter({
    name: "voice_turns_total",
    help: "Agent replies; ai=false means the deterministic fallback was spoken",
    labelNames: ["ai"] as const,
    registers: [this.registry],
  });
  readonly fallbacks = new Counter({
    name: "voice_fallbacks_total",
    help: "LLM failures and rejected phrasings that fell back to deterministic behaviour",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly tools = new Counter({
    name: "voice_tool_runs_total",
    help: "Tool executions (live and background)",
    labelNames: ["tool", "ok"] as const,
    registers: [this.registry],
  });
  readonly questions = new Counter({
    name: "voice_knowledge_questions_total",
    help: "Caller questions, answered from knowledge or with the safe reply",
    labelNames: ["answered"] as const,
    registers: [this.registry],
  });
  readonly cost = new Counter({
    name: "voice_usage_cost_micros_total",
    help: "Estimated usage cost in micro-dollars",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });
  readonly whatsapp = new Counter({
    name: "whatsapp_events_total",
    help: "WhatsApp webhook events by kind and what happened to them",
    labelNames: ["event", "result"] as const,
    registers: [this.registry],
  });
  readonly whatsappReplies = new Counter({
    name: "whatsapp_agent_replies_total",
    help: "What the agent did with new WhatsApp messages (text, voice, transfer, staff, no_agent …)",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  readonly whatsappSends = new Counter({
    name: "whatsapp_sends_total",
    help: "WhatsApp messages sent to customers, by result",
    labelNames: ["sender", "result"] as const,
    registers: [this.registry],
  });
  readonly deadLetters = new Counter({
    name: "queue_dead_letters_total",
    help: "Jobs that used up their retries",
    labelNames: ["queue"] as const,
    registers: [this.registry],
  });

  constructor(queues: QueueService) {
    collectDefaultMetrics({ register: this.registry });
    const registry = this.registry;
    new Gauge({
      name: "queue_jobs",
      help: "Jobs per queue and state (read when scraped)",
      labelNames: ["queue", "state"] as const,
      registers: [registry],
      async collect() {
        for (const name of [
          QUEUES.webhooks,
          QUEUES.notifications,
          QUEUES.crm,
          QUEUES.ingestion,
          QUEUES.analytics,
          QUEUES.whatsapp,
        ]) {
          const counts = await queues.queue(name).getJobCounts("waiting", "active", "delayed", "failed");
          for (const [state, n] of Object.entries(counts)) this.set({ queue: name, state }, n);
        }
      },
    });
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }
}
