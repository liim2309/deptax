import type { EcosystemAdapter } from './EcosystemAdapter';
import { NpmAdapter } from './NpmAdapter';
import { PubAdapter } from './PubAdapter';
import { PipAdapter } from './PipAdapter';

/** Returns one instance of every known adapter, wired with the WASM directory. */
export function getAdapters(wasmDir: string = ''): EcosystemAdapter[] {
  return [new NpmAdapter(wasmDir), new PubAdapter(wasmDir), new PipAdapter(wasmDir)];
}

/**
 * Runs `detect()` on every adapter and returns only those that are active
 * for the given workspace root.
 */
export async function detectAdapters(
  workspaceRoot: string,
  wasmDir: string = '',
): Promise<EcosystemAdapter[]> {
  const adapters = getAdapters(wasmDir);
  const checks = await Promise.all(
    adapters.map(async (adapter) => ({ adapter, active: await adapter.detect(workspaceRoot) })),
  );
  return checks.filter((c) => c.active).map((c) => c.adapter);
}
