export function defineTheme(theme) {
  return theme
}

export function checkThemeDefinition(theme) {
  const contexts = new Set(theme?.manifest?.routes?.map((route) => route.context))
  const valid =
    theme?.contractVersion === "v1alpha1" &&
    typeof theme?.manifest?.id === "string" &&
    typeof theme?.manifest?.name === "string" &&
    typeof theme?.manifest?.version === "string" &&
    contexts.has("home") &&
    contexts.has("content") &&
    contexts.has("notFound") &&
    theme?.fixtures?.home?.kind === "home" &&
    Array.isArray(theme?.fixtures?.content) &&
    theme.fixtures.content.every((entry) => entry.kind === "content") &&
    theme?.fixtures?.notFound?.kind === "notFound"
  return {
    ok: valid,
    diagnostics: valid
      ? []
      : [{ code: "THEME_SCHEMA_INVALID", severity: "error", message: "Invalid fixture theme." }],
  }
}
