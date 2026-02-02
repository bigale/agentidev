/* tslint:disable */
/* eslint-disable */
/**
 * Convenience function: parse grammar and input in one step
 */
export function parse_ixml(grammar: string, input: string): ParseResult;
/**
 * Get version information
 */
export function version(): string;
/**
 * Get conformance information
 */
export function conformance_info(): string;
/**
 * Parse iXML and return HTML template (for WASMZ wasm:// routing)
 */
export function parse_ixml_template(grammar: string, input: string): string;
/**
 * Load example grammar and input (returns HTML template)
 */
export function load_example_template(example_name: string): string;
/**
 * WASM-friendly iXML parser
 */
export class IxmlParser {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a new parser from an iXML grammar
   */
  constructor(grammar: string);
  /**
   * Parse input text according to the grammar
   */
  parse(input: string): ParseResult;
  /**
   * Get the number of rules in the grammar (for debugging)
   */
  rule_count(): number;
}
/**
 * Result type for JavaScript interop
 */
export class ParseResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly success: boolean;
  readonly output: string;
  readonly error: string | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_parseresult_free: (a: number, b: number) => void;
  readonly parseresult_success: (a: number) => number;
  readonly parseresult_output: (a: number) => [number, number];
  readonly parseresult_error: (a: number) => [number, number];
  readonly __wbg_ixmlparser_free: (a: number, b: number) => void;
  readonly ixmlparser_new: (a: number, b: number) => [number, number, number];
  readonly ixmlparser_parse: (a: number, b: number, c: number) => number;
  readonly ixmlparser_rule_count: (a: number) => number;
  readonly parse_ixml: (a: number, b: number, c: number, d: number) => number;
  readonly version: () => [number, number];
  readonly conformance_info: () => [number, number];
  readonly parse_ixml_template: (a: number, b: number, c: number, d: number) => [number, number];
  readonly load_example_template: (a: number, b: number) => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
