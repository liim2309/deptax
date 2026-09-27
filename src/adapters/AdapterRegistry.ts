import type { EcosystemAdapter } from './EcosystemAdapter';
import { NpmAdapter } from './NpmAdapter';
import { PubAdapter } from './PubAdapter';
import { PipAdapter } from './PipAdapter';

/** Returns one instance of every known adapter, wired with the WASM directory. */
export function getAdapters(wasmDir: string): EcosystemAdapter[] {
  return [new NpmAdapter(wasmDir), new PubAdapter(wasmDir), new PipAdapter(wasmDir)];
}

/** Adapters whose ecosystem is present in the workspace. */
export async function detectAdapters(workspaceRoot: string, wasmDir: string): Promise<EcosystemAdapter[]> {
  const adapters = getAdapters(wasmDir);
  const active = await Promise.all(adapters.map((a) => a.detect(workspaceRoot)));
  return adapters.filter((_, i) => active[i]);
}
