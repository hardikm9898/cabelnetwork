/** Trims and collapses internal whitespace. Case is preserved (names are never re-cased). */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Case- and space-insensitive key used for duplicate detection (e.g. society names). */
export function matchKey(value: string): string {
  return cleanText(value).toLowerCase();
}
