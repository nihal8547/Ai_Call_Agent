import { Global, Module } from "@nestjs/common";
import { TokenService } from "../../common/auth/token.service";
import { AuditModule } from "../audit/audit.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./mfa.service";
import { PasswordResetService } from "./password-reset.service";

@Global()
@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService, MfaService, PasswordResetService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
