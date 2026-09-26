import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { InvitationsController } from "./invitations.controller";
import { MembersController } from "./members.controller";
import { RolesController } from "./roles.controller";

@Module({
  imports: [AuditModule],
  controllers: [MembersController, RolesController, InvitationsController],
})
export class UsersModule {}
