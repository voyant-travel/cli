const report = {
  schemaVersion: "voyant.theme.tooling.v1" as const,
  ok: true,
  diagnostics: [],
}

export async function validateTheme() {
  return report
}

export async function buildTheme() {
  return report
}

export async function developTheme() {
  return { url: "http://127.0.0.1:4321", async close() {} }
}
