/**
 * OpenTelemetry tracing, loaded before anything else so HTTP, Fastify, Postgres (pg), Redis and
 * outgoing fetch calls are instrumented. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (OTLP/HTTP,
 * e.g. an OpenTelemetry Collector, Grafana Tempo, Honeycomb, Datadog).
 */
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "voice-api",
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and not useful here
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
