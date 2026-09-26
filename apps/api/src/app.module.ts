import { type DynamicModule, Module, RequestMethod } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "./config/env";
import { InfraModule } from "./infra/infra.module";
import { HealthModule } from "./modules/health/health.module";

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
      ],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
      exports: [API_ENV],
    };
  }
}
