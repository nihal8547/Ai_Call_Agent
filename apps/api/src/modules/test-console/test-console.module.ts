import { Module } from "@nestjs/common";
import { TestConsoleController } from "./test-console.controller";
import { TestConsoleService } from "./test-console.service";

@Module({ controllers: [TestConsoleController], providers: [TestConsoleService] })
export class TestConsoleModule {}
