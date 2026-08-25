export function canonicalizeSourceUrl(rawUrl: string, explicitCanonical?: string): string {
  const input = explicitCanonical ?? rawUrl;
  try {
    const parsed = new URL(input);
    parsed.hash = '';
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return input.trim();
  }
}
