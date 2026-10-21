/** Pure whitelist for the existing Control observation input. No Pi runtime imports. */
export function watchReadInput(value: unknown): { path: string; offset?: number; limit?: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const path = source.path ?? source.file_path;
  if (typeof path !== "string" || !path || path.length > 4_000 || /[\p{Cc}\p{Cf}]/u.test(path)) return null;
  const result: { path: string; offset?: number; limit?: number } = { path };
  for (const key of ["offset", "limit"] as const) {
    const number = source[key];
    if (number === undefined || number === null) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
    result[key] = number;
  }
  return result;
}
