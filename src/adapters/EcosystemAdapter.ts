import type { ModuleInfo, NameSet } from '../model/ModuleModel';
import type { ProjectImport } from '../analysis/ProjectModel';
import type { DeclaredDependency, Ecosystem } from '../types/index';

/** Key of the project root in the package graph. */
export const ROOT_NODE = '<root>';

/** One installed package. */
export interface PackageNode {
  /** Unique within the graph (npm: real path; pub/pip: package name). */
  id: string;
  name: string;
  version: string | null;
  dir: string | null;
  /** Bytes installed for this package alone. */
  diskBytes: number;
  /** Every loadable code file of the package with its size in bytes. */
  codeFiles: Map<string, number>;
  /** Public entry points: the roots of the package's loadable code. */
  entryFiles: string[];
  hasCli: boolean;
  isTypes: boolean;
  /** Provided by the language SDK (Flutter, …); never scored. */
  isSdk: boolean;
}

/** A project import resolved against the installed packages. */
export interface ResolvedImport extends ProjectImport {
  file: string;
  /** Package name the specifier refers to (even when not installed). */
  packageName: string | null;
  /** Graph node the import lands in, when installed. */
  packageId: string | null;
  /** Module files the import loads. Empty when resolution failed. */
  targets: string[];
  /** Names needed from a specific target, when they differ from `names`. */
  targetNames?: Map<string, NameSet>;
}

/** Everything the scan engine needs from one ecosystem. */
export interface EcosystemModel {
  ecosystem: Ecosystem;
  declared: DeclaredDependency[];
  /** Declared dependency name → graph node id (installed ones only). */
  declaredNodes: Map<string, string>;
  /** Why a declared dependency has no node. */
  missingReasons: Map<string, string>;
  nodes: Map<string, PackageNode>;
  /** Package graph including `ROOT_NODE` → declared dependencies. */
  edges: Map<string, string[]>;
  /** Project source files that were analysed. */
  projectFiles: string[];
  imports: ResolvedImport[];
  /** Graph node owning a module file. */
  ownerOf(file: string): string | null;
  /** Size in bytes of a module (all files of a Dart library). */
  moduleBytes(file: string): number;
  analyzeModule(file: string): Promise<ModuleInfo | null>;
  sideEffectFree(file: string): boolean;
  warnings: string[];
}

export interface EcosystemAdapter {
  readonly ecosystem: Ecosystem;
  /** Does this workspace use the ecosystem? */
  detect(workspaceRoot: string): Promise<boolean>;
  /** Build the package graph and analyse project imports. */
  load(workspaceRoot: string, sourceFiles: string[]): Promise<EcosystemModel>;
  /** Project source files this adapter analyses. */
  isSourceFile(file: string): boolean;
  /** Manifest files marking a separate project; subdirectories holding one are not scanned. */
  readonly manifestFiles: readonly string[];
}
