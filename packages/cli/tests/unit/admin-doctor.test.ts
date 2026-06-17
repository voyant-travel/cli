import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { adminDoctorCommand } from "../../src/commands/admin-doctor.js"
import { adminGenerateCommand } from "../../src/commands/admin-generate.js"

function makeCtx(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

function writePackage(
  root: string,
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = join(root, "node_modules", ...name.split("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", ...pkg }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
  }
}

const FOO_ADMIN_SOURCE = `
export function createFooAdminExtension(options = {}) {
  const { path = "/foo" } = options
  return { id: "foo", routes: [{ id: "foo-index", path }] }
}
`

function writeFixture(root: string) {
  writeFileSync(join(root, "voyant.config.ts"), `export default { modules: ["@voyant-travel/foo"] }\n`)
  writePackage(root, "@voyant-travel/foo", { exports: { ".": "./src/index.ts" } })
  writePackage(
    root,
    "@voyant-travel/foo-react",
    { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
    { "src/admin/index.tsx": FOO_ADMIN_SOURCE },
  )
}

describe("adminDoctorCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-admin-doctor-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fails when no config file is found", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No voyant.config.* found")
  })

  it("reports Finding A when the generated file is missing", async () => {
    writeFixture(tmp)
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("[admin-doctor] A: generated file")
    expect(out).toContain("@voyant-travel/foo-react/admin")
  })

  it("reports Finding A when an admin entry is not imported", async () => {
    writeFixture(tmp)
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      `export const generatedAdminExtensionFactories = {} as const\n`,
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain(
      "A: admin entry @voyant-travel/foo-react/admin (module @voyant-travel/foo) is not imported",
    )
  })

  it("reports Finding B for imports whose module left the manifest", async () => {
    writeFixture(tmp)
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      [
        `import { createFooAdminExtension } from "@voyant-travel/foo-react/admin"`,
        `import { createGoneAdminExtension } from "@voyant-travel/gone-react/admin"`,
        `export const generatedAdminExtensionFactories = {`,
        `  foo: createFooAdminExtension,`,
        `  gone: createGoneAdminExtension,`,
        `} as const`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("B: @voyant-travel/gone-react/admin is imported")
    expect(out).not.toContain("B: @voyant-travel/foo-react/admin")
    // foo is imported, so no Finding A for it either.
    expect(out).not.toContain("A: admin entry @voyant-travel/foo-react/admin")
  })

  it("does not report Finding B when only the module's UI package is missing", async () => {
    writeFixture(tmp)
    // @voyant-travel/bar stays in the manifest (module package present) but has
    // no resolvable bar-react package — a stale generated import for it is a
    // regenerate-needed situation, NOT "module left the manifest".
    writeFileSync(
      join(tmp, "voyant.config.ts"),
      `export default { modules: ["@voyant-travel/foo", "@voyant-travel/bar"] }\n`,
    )
    writePackage(tmp, "@voyant-travel/bar", { exports: { ".": "./src/index.ts" } })
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      [
        `import { createFooAdminExtension } from "@voyant-travel/foo-react/admin"`,
        `import { createBarAdminExtension } from "@voyant-travel/bar-react/admin"`,
        `export const generatedAdminExtensionFactories = {`,
        `  foo: createFooAdminExtension,`,
        `  bar: createBarAdminExtension,`,
        `} as const`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).not.toContain("B: @voyant-travel/bar-react/admin")
  })

  it("reports Finding C when neither a route file nor a module entry binds a path", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const missing = makeCtx([], tmp)
    expect(await adminDoctorCommand(missing.ctx)).toBe(0)
    expect(missing.stdout.join("")).toContain(
      "C: /foo (extension @voyant-travel/foo-react/admin) is bound by no route file and " +
        "no entry in src/admin.routes.generated.tsx",
    )

    mkdirSync(join(tmp, "src", "routes", "_workspace", "foo"), { recursive: true })
    writeFileSync(join(tmp, "src", "routes", "_workspace", "foo", "index.tsx"), "export {}\n")
    const present = makeCtx([], tmp)
    expect(await adminDoctorCommand(present.ctx)).toBe(0)
    expect(present.stdout.join("")).not.toContain("C: /foo")
  })

  it("Finding C is satisfied by an entry in the code-assembled module (fileless routes)", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    // No route file anywhere — only the RFC §4.8 code-assembled module binds /foo.
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.routes.generated.tsx"),
      [
        `// GENERATED by voyant admin generate --routes — do not edit.`,
        `export const FooIndexRoute = createRoute({`,
        `  getParentRoute: workspace,`,
        `  path: "/foo",`,
        `  ...adminExtensionRouteOptions(fooExtension, "foo-index", runtime),`,
        `})`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    const out = stdout.join("")
    expect(out).not.toContain("C: /foo")
    expect(out).toContain("0 finding(s)")
  })

  it("honors --routes-out for a non-default module path", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })
    const custom = join(tmp, "src", "admin-routes.custom.tsx")
    writeFileSync(custom, `const r = { path: "/foo" }\n`)
    const { ctx, stdout } = makeCtx(["--routes-out", custom], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    expect(stdout.join("")).not.toContain("C: /foo")
  })

  it("is clean after voyant admin generate (and always exits 0)", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).not.toContain(" A: ")
    expect(out).not.toContain(" B: ")
    expect(out).toContain(
      "C: skipped route parity — no src/routes/_workspace directory and no " +
        "src/admin.routes.generated.tsx in host",
    )
    expect(out).toContain("D: skipped destination parity — no src/lib/admin-destinations.ts")
    expect(out).toContain("0 finding(s)")
  })

  describe("Finding D (destination parity)", () => {
    const DESTINATION_FOO_SOURCE = `
declare module "@voyant-travel/admin" {
  interface AdminDestinations {
    "foo.list": Record<string, never>
    "foo.detail": { fooId: string }
  }
}
export function createFooAdminExtension(options = {}) {
  const { path = "/foo" } = options
  return { id: "foo", routes: [{ id: "foo-index", path }] }
}
`

    function writeDestinationsFixture(root: string, resolverKeys: ReadonlyArray<string>) {
      writeFileSync(
        join(root, "voyant.config.ts"),
        `export default { modules: ["@voyant-travel/foo"] }\n`,
      )
      writePackage(root, "@voyant-travel/foo", { exports: { ".": "./src/index.ts" } })
      writePackage(
        root,
        "@voyant-travel/foo-react",
        { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
        { "src/admin/index.tsx": DESTINATION_FOO_SOURCE },
      )
      mkdirSync(join(root, "src", "lib"), { recursive: true })
      writeFileSync(
        join(root, "src", "lib", "admin-destinations.ts"),
        [
          `import type { AdminDestinationResolvers } from "@voyant-travel/admin"`,
          ``,
          `export const destinations = {`,
          ...resolverKeys.map((key) => `  "${key}": () => "/${key.split(".")[0]}",`),
          `} satisfies AdminDestinationResolvers`,
          ``,
        ].join("\n"),
      )
    }

    it("reports declared destinations that have no resolver", async () => {
      writeDestinationsFixture(tmp, ["foo.list"])
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).toContain(
        `D: destination "foo.detail" declared by @voyant-travel/foo-react/admin has no resolver`,
      )
      expect(out).not.toContain(`D: destination "foo.list"`)
    })

    it("reports resolvers that match no declared destination", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail", "gone.detail"])
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).toContain(`D: resolver for "gone.detail"`)
      expect(out).toContain("matches no declared destination")
      expect(out).not.toContain(`D: destination "foo.detail"`)
      expect(out).not.toContain(`D: resolver for "foo.list"`)
    })

    it("is clean when declarations and resolvers match", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail"])
      // Compose first so Findings A/B are quiet and only D-parity is measured.
      await adminGenerateCommand(makeCtx([], tmp).ctx)
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).not.toContain(" D: ")
      expect(out).toContain("0 finding(s)")
    })

    it("skips when the resolver file has no satisfies-marked map", async () => {
      writeDestinationsFixture(tmp, [])
      writeFileSync(
        join(tmp, "src", "lib", "admin-destinations.ts"),
        `export const destinations = { "foo.list": () => "/foo" }\n`,
      )
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      expect(stdout.join("")).toContain(
        "D: skipped destination parity — no `satisfies AdminDestinationResolvers` map",
      )
    })

    it("honors --destinations for a non-default resolver path", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail"])
      const custom = join(tmp, "src", "nav.ts")
      writeFileSync(
        custom,
        `export const map = { "foo.list": () => "/foo" } satisfies AdminDestinationResolvers\n`,
      )
      const { ctx, stdout } = makeCtx(["--destinations", custom], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      expect(stdout.join("")).toContain(`D: destination "foo.detail" declared by`)
    })
  })
})

describe("Finding C — redirects, nested children, and the built-in core entry", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-admin-doctor-nested-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const NESTED_FOO_SOURCE = `
export function createFooAdminExtension(options = {}) {
  const { basePath = "/foo" } = options
  return {
    id: "foo",
    routes: [
      { id: "foo-index", path: basePath, title: "Foo", redirectTo: \`\${basePath}/items\` },
      { id: "foo-items", path: \`\${basePath}/items\`, title: "Items", page: () => import("./i.js") },
      {
        id: "foo-area",
        path: "/foo-area",
        title: "Area",
        page: () => import("./area.js"),
        children: [
          { id: "foo-area-index", path: "/", title: "Area", redirectTo: "/foo-area/one" },
          { id: "foo-area-one", path: "/one", title: "One", page: () => import("./one.js") },
          ...(options.extraPages ?? []),
        ],
      },
    ],
  }
}
`

  function writeNestedFixture(root: string) {
    writeFileSync(join(root, "voyant.config.ts"), `export default { modules: ["@voyant-travel/foo"] }\n`)
    writePackage(root, "@voyant-travel/foo", { exports: { ".": "./src/index.ts" } })
    writePackage(
      root,
      "@voyant-travel/foo-react",
      { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
      { "src/admin/index.tsx": NESTED_FOO_SOURCE },
    )
  }

  it("a module-bound redirect satisfies its path with no file and no page", async () => {
    writeNestedFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const unbound = makeCtx([], tmp)
    expect(await adminDoctorCommand(unbound.ctx)).toBe(0)
    expect(unbound.stdout.join("")).toContain("C: /foo (extension @voyant-travel/foo-react/admin)")

    // The code-assembled module (which emits redirects as plain routes)
    // binds it — no file ever exists for /foo.
    expect(await adminGenerateCommand(makeCtx(["--routes"], tmp).ctx)).toBe(0)
    const bound = makeCtx([], tmp)
    expect(await adminDoctorCommand(bound.ctx)).toBe(0)
    expect(bound.stdout.join("")).not.toContain("C: /foo")
    expect(bound.stdout.join("")).toContain("0 finding(s)")
  })

  it("traverses children: absolute child paths must be bound; index and runtime children never report", async () => {
    writeNestedFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const unbound = makeCtx([], tmp)
    expect(await adminDoctorCommand(unbound.ctx)).toBe(0)
    const out = unbound.stdout.join("")
    expect(out).toContain("C: /foo-area (extension @voyant-travel/foo-react/admin)")
    expect(out).toContain("C: /foo-area/one (extension @voyant-travel/foo-react/admin)")
    // Index children have no file-route spelling — never reported.
    expect(out).not.toContain("C: /foo-area/ ")
    // Runtime-bound children (the extraPages spread) are invisible to the scan.
    expect(out).not.toContain("extraPages")

    // The nested module binding (parent + getParentRoute children) satisfies
    // the child paths via absolute-path reconstruction.
    expect(await adminGenerateCommand(makeCtx(["--routes"], tmp).ctx)).toBe(0)
    const bound = makeCtx([], tmp)
    expect(await adminDoctorCommand(bound.ctx)).toBe(0)
    expect(bound.stdout.join("")).toContain("0 finding(s)")
  })

  it("includes the built-in core entry when resolvable and is clean after --routes", async () => {
    writeNestedFixture(tmp)
    writePackage(
      tmp,
      "@voyant-travel/admin-app",
      { exports: { ".": "./src/index.ts", "./core-extension": "./src/core-extension/index.tsx" } },
      { "src/core-extension/index.tsx": `export function createAdminCoreExtension() {}\n` },
    )
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const unbound = makeCtx([], tmp)
    expect(await adminDoctorCommand(unbound.ctx)).toBe(0)
    const out = unbound.stdout.join("")
    expect(out).toContain("C: /account (extension @voyant-travel/admin-app/core-extension)")
    expect(out).toContain("C: /settings (extension @voyant-travel/admin-app/core-extension)")
    expect(out).toContain("C: /settings/team (extension @voyant-travel/admin-app/core-extension)")
    // The root path stays host-owned; index children never report.
    expect(out).not.toContain("C: / (")
    expect(out).not.toContain("C: /settings/ ")

    expect(await adminGenerateCommand(makeCtx(["--routes"], tmp).ctx)).toBe(0)
    const bound = makeCtx([], tmp)
    expect(await adminDoctorCommand(bound.ctx)).toBe(0)
    expect(bound.stdout.join("")).toContain("0 finding(s)")
  })

  it("skips the core entry when admin-app lacks the ./core-extension export", async () => {
    writeNestedFixture(tmp)
    writePackage(tmp, "@voyant-travel/admin-app", { exports: { ".": "./src/index.ts" } })
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    expect(stdout.join("")).not.toContain("@voyant-travel/admin-app/core-extension")
  })
})

describe("Finding D — generated-resolver gate (RFC §4.7 endgame)", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-admin-doctor-gate-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const ANNOTATED_SOURCE = `
declare module "@voyant-travel/admin" {
  interface AdminDestinations {
    "foo.list": Record<string, never>
    "foo.detail": { fooId: string }
    "foo.custom": { tab?: string }
  }
}
export function createFooAdminExtension(options = {}) {
  const { basePath = "/foo" } = options
  return defineAdminExtension({
    id: "foo",
    routes: [
      { id: "foo-index", path: basePath, title: "Foo", destination: "foo.list", page: () => import("./foo.js") },
      {
        id: "foo-detail",
        path: \`\${basePath}/$id\`,
        title: "Foo",
        destination: "foo.detail",
        destinationParams: { id: "fooId" },
        page: () => import("./foo-detail.js"),
      },
    ],
  })
}
`

  function writeGateFixture(root: string, source = ANNOTATED_SOURCE) {
    writeFileSync(join(root, "voyant.config.ts"), `export default { modules: ["@voyant-travel/foo"] }\n`)
    writePackage(root, "@voyant-travel/foo", { exports: { ".": "./src/index.ts" } })
    writePackage(
      root,
      "@voyant-travel/foo-react",
      { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
      { "src/admin/index.tsx": source },
    )
    // Host resolver map: spreads the generated map, hand-writes the custom key.
    mkdirSync(join(root, "src", "lib"), { recursive: true })
    writeFileSync(
      join(root, "src", "lib", "admin-destinations.ts"),
      [
        `import type { AdminDestinationResolvers } from "@voyant-travel/admin"`,
        `import { generatedAdminDestinations } from "@/admin.destinations.generated"`,
        ``,
        `export const destinations = {`,
        `  ...generatedAdminDestinations,`,
        `  "foo.custom": () => "/foo?tab=custom",`,
        `} satisfies AdminDestinationResolvers`,
        ``,
      ].join("\n"),
    )
  }

  async function composeAll(root: string) {
    expect(await adminGenerateCommand(makeCtx([], root).ctx)).toBe(0)
    expect(await adminGenerateCommand(makeCtx(["--destinations"], root).ctx)).toBe(0)
  }

  it("is clean (exit 0) when the generated map matches the annotations", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    const out = stdout.join("")
    expect(out).not.toContain(" D: ")
    expect(out).toContain("0 finding(s)")
  })

  it("gates (exit 1) when annotations exist but the generated module is missing", async () => {
    writeGateFixture(tmp)
    expect(await adminGenerateCommand(makeCtx([], tmp).ctx)).toBe(0)
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(1)
    const out = stdout.join("")
    expect(out).toContain("is missing but 2 route contribution(s) declare a destination")
    expect(out).toContain("[gate]")
    expect(out).toContain("gating, exit 1")
  })

  it("gates (exit 1) on an annotated destination missing from the generated module", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    // A new annotation lands in the package without regenerating.
    writeGateFixture(
      tmp,
      ANNOTATED_SOURCE.replace(
        `{ id: "foo-index", path: basePath, title: "Foo", destination: "foo.list", page: () => import("./foo.js") },`,
        [
          `{ id: "foo-index", path: basePath, title: "Foo", destination: "foo.list", page: () => import("./foo.js") },`,
          `{ id: "foo-extra", path: \`\${basePath}/extra\`, title: "Foo", destination: "foo.custom", page: () => import("./foo-extra.js") },`,
        ].join("\n      "),
      ),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(1)
    const out = stdout.join("")
    expect(out).toContain(
      `D: annotated destination "foo.custom" (@voyant-travel/foo-react/admin) has no resolver`,
    )
    expect(out).toContain("[gate]")
  })

  it("gates (exit 1) on a generated resolver whose annotation vanished", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    // The annotation is removed from the package without regenerating.
    writeGateFixture(tmp, ANNOTATED_SOURCE.replace(`destination: "foo.list",`, ""))
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(1)
    const out = stdout.join("")
    expect(out).toContain(
      `D: generated resolver for "foo.list" in src/admin.destinations.generated.ts matches no`,
    )
    expect(out).toContain("[gate]")
  })

  it("gates (exit 1) on pure content drift even when the key sets match", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    // Same keys, different param mapping → emission drift.
    writeGateFixture(tmp, ANNOTATED_SOURCE.replace(`destinationParams: { id: "fooId" },`, ""))
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(1)
    expect(stdout.join("")).toContain(
      "D: src/admin.destinations.generated.ts is out of date — run `voyant admin generate --destinations` [gate]",
    )
  })

  it("skips the gate for an ejected module but keeps its keys for custom parity", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    // Eject: strip the generated header, keep a host-owned map with the keys.
    const outPath = join(tmp, "src", "admin.destinations.generated.ts")
    writeFileSync(
      outPath,
      [
        `// host-owned`,
        `export const generatedAdminDestinations = {`,
        `  "foo.list": () => "/foo",`,
        `  "foo.detail": ({ fooId }: { fooId: string }) => "/foo/" + fooId,`,
        `} satisfies Partial<AdminDestinationResolvers>`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("skipped generated-destinations gate")
    expect(out).toContain("ejected, host-owned")
    // foo.list / foo.detail resolve through the ejected map — no D parity findings.
    expect(out).not.toContain(`D: destination "foo.list"`)
    expect(out).not.toContain(`D: destination "foo.detail"`)
  })

  it("custom-resolver parity stays report-only (exit 0)", async () => {
    writeGateFixture(tmp)
    await composeAll(tmp)
    // A hand-written resolver for an undeclared key + a declared key with no
    // resolver anywhere — both report, neither gates.
    writeFileSync(
      join(tmp, "src", "lib", "admin-destinations.ts"),
      [
        `import type { AdminDestinationResolvers } from "@voyant-travel/admin"`,
        `import { generatedAdminDestinations } from "@/admin.destinations.generated"`,
        ``,
        `export const destinations = {`,
        `  ...generatedAdminDestinations,`,
        `  "gone.detail": () => "/gone",`,
        `} satisfies AdminDestinationResolvers`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    const out = stdout.join("")
    expect(out).toContain(`D: resolver for "gone.detail"`)
    expect(out).toContain(`D: destination "foo.custom"`)
    expect(out).not.toContain("[gate]")
    expect(out).toContain("2 finding(s)")
  })

  it("honors --destinations-out for a non-default generated module path", async () => {
    writeGateFixture(tmp)
    expect(await adminGenerateCommand(makeCtx([], tmp).ctx)).toBe(0)
    const custom = join(tmp, "src", "nav.generated.ts")
    expect(await adminGenerateCommand(makeCtx(["--destinations", "--out", custom], tmp).ctx)).toBe(
      0,
    )
    const { ctx } = makeCtx(["--destinations-out", custom], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
  })
})
