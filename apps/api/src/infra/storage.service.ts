import { Inject, Injectable } from "@nestjs/common";
import { createStorage, type ObjectStorage } from "@platform/storage";
import path from "node:path";
import { API_ENV, type ApiEnv } from "../config/env";

@Injectable()
export class StorageService {
  readonly storage: ObjectStorage;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    // Relative local paths resolve from the repository root, like the worker
    this.storage = createStorage(env, path.resolve(__dirname, "../../../.."));
  }
}
