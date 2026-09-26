import { Module } from "@nestjs/common";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { TestConsoleController } from "./test-console.controller";
import { TestConsoleService } from "./test-console.service";

@Module({
  imports: [KnowledgeModule],
  controllers: [TestConsoleController],
  providers: [TestConsoleService],
})
export class TestConsoleModule {}
