import { type DynamicModule, Module, RequestMethod } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { AuthGuard } from "./common/auth/auth.guard";
import { PermissionsGuard } from "./common/auth/permissions.guard";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter";
import { RateLimitGuard } from "./common/rate-limit/rate-limit";
import { API_ENV, type ApiEnv } from "./config/env";
import { InfraModule } from "./infra/infra.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { AgentsModule } from "./modules/agents/agents.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { CallsModule } from "./modules/calls/calls.module";
import { HealthModule } from "./modules/health/health.module";
import { AppointmentsModule } from "./modules/appointments/appointments.module";
import { KnowledgeModule } from "./modules/knowledge/knowledge.module";
import { ToolsModule } from "./modules/tools/tools.module";
import { LeadsModule } from "./modules/leads/leads.module";
import { PhoneNumbersModule } from "./modules/phone-numbers/phone-numbers.module";
import { TelephonyModule } from "./modules/telephony/telephony.module";
import { TestConsoleModule } from "./modules/test-console/test-console.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { UsersModule } from "./modules/users/users.module";

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          // Named wildcard (path-to-regexp v8 syntax) so Nest does not warn about the legacy "*" route
          forRoutes: [{ path: "{*path}", method: RequestMethod.ALL }],
          pinoHttp: {
            level: env.LOG_LEVEL,
            // Never log credentials or session cookies
            redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
            ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
            autoLogging: { ignore: (req) => req.url === "/health" },
          },
        }),
        InfraModule,
        HealthModule,
        AuditModule,
        ToolsModule,
        AuthModule,
        TenantsModule,
        UsersModule,
        ApiKeysModule,
        TelephonyModule,
        CallsModule,
        LeadsModule,
        PhoneNumbersModule,
        AgentsModule,
        AnalyticsModule,
        TestConsoleModule,
        KnowledgeModule,
        AppointmentsModule,
      ],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        // Order matters: rate limit → authenticate → authorise
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
      exports: [API_ENV],
    };
  }
}
