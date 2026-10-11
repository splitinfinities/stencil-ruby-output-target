// Placeholder so the runtime type-checks in this package. The output target
// writes the real manifest (one entry per generated element) next to the runtime.

export interface ElementSpec {
  readonly model?: { readonly prop: string; readonly event: string };
  readonly properties: readonly string[];
  readonly events: readonly string[];
}

export const STENCIL_ELEMENTS: Readonly<Record<string, ElementSpec>> = {};
