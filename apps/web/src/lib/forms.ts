import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { ApiError } from "./api/errors";

/** Map API field errors (problem+json `errors[]`) onto form fields; returns true if any matched */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
): boolean {
  if (!(err instanceof ApiError)) return false;
  let matched = false;
  for (const e of err.fieldErrors) {
    if (e.path) {
      setError(e.path as Path<T>, { type: "server", message: e.message });
      matched = true;
    }
  }
  return matched;
}
