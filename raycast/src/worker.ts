import { environment } from "@raycast/api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeWorker, type WorkerConfiguration, type WorkerOptions, type WorkerRequest } from "./transport";

export type { SavedSession } from "./transport";

export async function runWorker(request: WorkerRequest, options?: WorkerOptions) {
  let configuration: WorkerConfiguration;
  try {
    configuration = JSON.parse(await readFile(join(environment.assetsPath, "runtime.json"), "utf8"));
  } catch {
    throw new Error("Jimmy's local runtime configuration is missing. Run npm run dev in the repository's raycast folder to regenerate it.");
  }
  return executeWorker(configuration, request, options);
}
