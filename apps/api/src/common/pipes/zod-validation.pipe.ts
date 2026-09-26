import { HttpStatus, type PipeTransform } from "@nestjs/common";
import { zodIssuesToFieldErrors } from "@platform/shared";
import { type z } from "zod";
import { AppException } from "../filters/problem-details.filter";

/**
 * Validates and transforms a request part with a zod schema:
 *   @Body(new ZodValidationPipe(CreateAgentBody)) body: CreateAgentBody
 * Unknown keys are stripped by zod objects by default.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Request validation failed",
        zodIssuesToFieldErrors(result.error.issues),
      );
    }
    return result.data;
  }
}
