export const SPEC_SUFFIX = '.helpai.md';

export type ErrorCode =
  | 'MULTIPLE_SPEC_FILES_IN_FOLDER'
  | 'BROKEN_SPEC_LINK'
  | 'CIRCULAR_SPEC_DEPENDENCY';

export interface ValidationError {
  code: ErrorCode;
  message: string;
  /** Absolute paths involved in the error. */
  paths: string[];
}

export interface SpecNode {
  /** Absolute path of the .helpai.md file. */
  specPath: string;
  /** Absolute path of the folder the spec governs (dirname(specPath)). */
  folderPath: string;
  /** True when the spec lives under rootPath (scanned), false when reached via a link. */
  inRoot: boolean;
  /** Absolute paths of the specs this spec links to (direct upstream). */
  links: string[];
}

export interface SpecGraph {
  rootPath: string;
  nodes: Map<string, SpecNode>;
  /** Upstream dependencies: spec -> specs it links to. */
  upstream(specPath: string): string[];
  /** Downstream dependents: spec -> specs that link to it. */
  downstream(specPath: string): string[];
}

export interface AnalysisResult {
  rootPath: string;
  specs: SpecNode[];
  graph: SpecGraph;
  errors: ValidationError[];
}
