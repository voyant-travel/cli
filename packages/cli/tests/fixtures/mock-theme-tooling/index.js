export function defineTheme(theme) {
  return theme
}

export function checkThemeDefinition(theme) {
  const contexts = new Set(theme?.manifest?.routes?.map((route) => route.context))
  const contentRoutes = theme?.manifest?.routes?.filter((route) => route.context === "content")
  const valid =
    theme?.contractVersion === "v1alpha4" &&
    typeof theme?.manifest?.id === "string" &&
    typeof theme?.manifest?.name === "string" &&
    typeof theme?.manifest?.version === "string" &&
    contexts.has("home") &&
    contexts.has("content") &&
    contexts.has("notFound") &&
    contexts.has("tourIndex") &&
    contexts.has("tourDetail") &&
    contentRoutes.length > 0 &&
    contentRoutes.every((route) => /\[(?:\.\.\.)?[A-Za-z][A-Za-z0-9_]*\]/.test(route.pattern)) &&
    theme?.fixtures?.home?.kind === "home" &&
    Array.isArray(theme?.fixtures?.content) &&
    theme.fixtures.content.every((entry) => entry.kind === "content") &&
    theme?.fixtures?.tourIndex?.kind === "tourIndex" &&
    Array.isArray(theme?.fixtures?.tourDetail) &&
    theme.fixtures.tourDetail.every((entry) => entry.kind === "tourDetail") &&
    theme?.fixtures?.notFound?.kind === "notFound"
  return {
    ok: valid,
    diagnostics: valid
      ? []
      : [{ code: "THEME_SCHEMA_INVALID", severity: "error", message: "Invalid fixture theme." }],
  }
}
