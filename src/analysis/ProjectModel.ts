import type { NameSet } from '../model/ModuleModel';

/** How one export is used by project code. */
export interface SymbolUse {
  references: number;
  typeReferences: number;
  callArities: number[];
}

/** One import (or require / re-export) in a project source file. */
export interface ProjectImport {
  specifier: string;
  kind: 'import' | 'require' | 'dynamic' | 'reexport' | 'implicit';
  line: number;
  endLine: number;
  /** The module must be loaded at runtime (false for type-only imports). */
  runtime: boolean;
  /** Export names needed at runtime; empty when only the module's side effects are needed. */
  names: NameSet;
  /** Per-export usage, for reporting and recipe preconditions. */
  symbols: Map<string, SymbolUse>;
  /** Python `from m import x`: the attributes used on `x`, in case `x` is a submodule. */
  memberNames?: Map<string, NameSet>;
}

export interface ProjectFileAnalysis {
  imports: ProjectImport[];
  hasJsx: boolean;
  parseErrors: boolean;
}
