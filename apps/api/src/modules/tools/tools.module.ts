import { Global, Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { ToolService } from "./tool.service";

@Global()
@Module({
  imports: [IntegrationsModule],
  providers: [ToolService],
  exports: [ToolService, IntegrationsModule],
})
export class ToolsModule {}
