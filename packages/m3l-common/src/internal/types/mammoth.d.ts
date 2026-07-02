/**
 * Minimal ambient declaration for `mammoth`.
 *
 * `mammoth` ships no type declarations and there is no `@types/mammoth`. The
 * DOCX extractor only uses `extractRawText`, so we declare just that surface to
 * keep `strict` type-checking without reaching for `any`.
 */
declare module "mammoth" {
  export function extractRawText(
    input: { path: string } | { buffer: Buffer },
  ): Promise<{ value: string; messages: unknown[] }>;
}
