import { Global, Module } from "@nestjs/common";
import { PlatformMailService } from "./platform-mail.service";

@Global()
@Module({ providers: [PlatformMailService], exports: [PlatformMailService] })
export class MailModule {}
