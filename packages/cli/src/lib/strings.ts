/**
 * Normalize a name into kebab-case (lowercase, hyphen-separated).
 *
 * Splits on whitespace, underscores, and camelCase boundaries. Strips
 * characters outside `[a-z0-9-]`.
 */
export function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Convert to camelCase (first word lowercase, subsequent words capitalized). */
export function toCamelCase(input: string): string {
  const parts = toKebabCase(input).split("-").filter(Boolean)
  if (parts.length === 0) return ""
  const [first, ...rest] = parts
  return first + rest.map(capitalize).join("")
}

/** Convert to PascalCase (every word capitalized, no separators). */
export function toPascalCase(input: string): string {
  return toKebabCase(input).split("-").filter(Boolean).map(capitalize).join("")
}

/** Locale-independent UTF-16 code-unit ordering for deterministic artifacts. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function capitalize(word: string): string {
  if (word.length === 0) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}
