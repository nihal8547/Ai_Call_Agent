import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { IdParam, StartTestSessionBody, TestMessageBody } from "@platform/shared";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions, UserOnly } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { TestConsoleService } from "./test-console.service";

/** Try an agent in text before publishing it. Tools are simulated; nothing is stored. */
@Controller()
@UserOnly()
export class TestConsoleController {
  constructor(private readonly console: TestConsoleService) {}

  @RequirePermissions("agents:write")
  @Post("agents/:id/test-sessions")
  start(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(StartTestSessionBody)) body: z.output<typeof StartTestSessionBody>,
  ) {
    return this.console.start(auth, id, body);
  }

  @RequirePermissions("agents:write")
  @Post("test-sessions/:id/messages")
  @HttpCode(200)
  @RateLimit({ name: "test-console", limit: 120, windowSeconds: 60, by: "ip" })
  message(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(TestMessageBody)) body: z.output<typeof TestMessageBody>,
  ) {
    return this.console.message(auth, id, body.text);
  }
}
