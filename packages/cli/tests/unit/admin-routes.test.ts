import { describe, expect, it } from "vitest"

import {
  alternativeRouteFileRelPaths,
  canonicalRouteFileRelPath,
  collectContributionRoutePaths,
  collectDestinationBindings,
  DEFAULT_ROUTES_MODULE_IMPORTS,
  fileRouteIdFor,
  GENERATED_DESTINATIONS_HEADER,
  GENERATED_ROUTE_HEADER,
  isExportedIdent,
  isGeneratedDestinationsFile,
  isGeneratedRouteFile,
  isImplementedContribution,
  renderAdminDestinationsModule,
  renderAdminRoutesModule,
  renderRouteFile,
  resolveAdminRoutesManifestConfig,
  resolveSearchSchemaIdent,
  routeIdPrefixFor,
  scanDeclaredDestinationKeys,
  scanExtensionId,
  scanGeneratedDestinationKeys,
  scanGeneratedModuleRoutePaths,
  scanResolverMapKeys,
  scanRouteContributions,
  workspaceRouteModuleFor,
} from "../../src/lib/admin-routes.js"

const PROMOTIONS_LIKE_SOURCE = `
import { defineAdminExtension } from "@voyant-travel/admin"
import { loadFooPage, FooPage } from "../foo-page.js"

export function createFooAdminExtension(options = {}) {
  const { label = "Foo", path = "/foo" } = options
  return defineAdminExtension({
    id: "foo",
    routes: [
      {
        id: "foo-index",
        path,
        title: label,
        ssr: "data-only",
        component: FooPage,
        loader: ({ queryClient, runtime }) =>
          loadFooPage(queryClient, { baseUrl: runtime.baseUrl, fetcher: runtime.fetcher }),
      },
    ],
  })
}
`

const MULTI_ROUTE_SOURCE = `
export function createLegalishAdminExtension(options = {}) {
  const { basePath = "/legalish", labels = {} } = options
  const { contracts = "Contracts" } = labels
  return defineAdminExtension({
    id: "legalish",
    routes: [
      { id: "legalish-contracts-index", path: \`\${basePath}/contracts\`, title: contracts },
      { id: "legalish-contracts-detail", path: \`\${basePath}/contracts/$id\`, title: contracts },
      { id: "legalish-static", path: "/legalish/static", title: contracts, component: StaticPage },
      { id: "legalish-search", path: "/legalish/search", title: contracts, component: SearchPage, validateSearch: parseSearch, preload: "intent" },
    ],
  })
}
`

describe("scanRouteContributions", () => {
  it("resolves shorthand paths via option-destructuring defaults", () => {
    const [route] = scanRouteContributions(PROMOTIONS_LIKE_SOURCE)
    expect(route).toMatchObject({
      id: "foo-index",
      path: "/foo",
      hasComponent: true,
      hasLoader: true,
      hasValidateSearch: false,
      ssr: "data-only",
      preload: null,
    })
  })

  it("resolves template-literal paths and keeps $param segments visible", () => {
    const routes = scanRouteContributions(MULTI_ROUTE_SOURCE)
    expect(routes.map((route) => route.path)).toEqual([
      "/legalish/contracts",
      "/legalish/contracts/$id",
      "/legalish/static",
      "/legalish/search",
    ])
    expect(routes[0]?.hasComponent).toBe(false)
    expect(routes[2]?.hasComponent).toBe(true)
    expect(routes[3]).toMatchObject({
      hasComponent: true,
      hasValidateSearch: true,
      preload: "intent",
      ssr: null,
    })
  })

  it("returns null path when an interpolation has no static default", () => {
    const source = `
      export function createBarAdminExtension({ basePath }) {
        return { id: "bar", routes: [{ id: "bar-index", path: \`\${basePath}/bar\` }] }
      }
    `
    const [route] = scanRouteContributions(source)
    expect(route?.id).toBe("bar-index")
    expect(route?.path).toBeNull()
  })

  it("returns an empty array when there is no routes array", () => {
    expect(scanRouteContributions(`export const x = 1`)).toEqual([])
  })

  it("parses boolean ssr literals", () => {
    const source = `
      const routes = { routes: [{ id: "a", path: "/a", ssr: true, component: A }] }
    `
    expect(scanRouteContributions(source)[0]?.ssr).toBe(true)
  })

  it("recognizes lazy page loaders as implementations (RFC §4.8)", () => {
    const source = `
      const x = { routes: [
        { id: "a", path: "/a", page: () => import("./pages/a.js") },
        { id: "b", path: "/b", component: B },
        { id: "c", path: "/c", title: "Meta only" },
      ] }
    `
    const [a, b, c] = scanRouteContributions(source)
    expect(a).toMatchObject({ hasPage: true, hasComponent: false })
    expect(b).toMatchObject({ hasPage: false, hasComponent: true })
    expect(c).toMatchObject({ hasPage: false, hasComponent: false })
    expect(
      [a, b, c].map((route) => route !== undefined && isImplementedContribution(route)),
    ).toEqual([true, true, false])
  })

  it("key-matches properties preceded by doc comments", () => {
    const source = `
      const x = { routes: [
        {
          id: "a",
          path: "/a",
          // weak-type rule workaround — hence adminRoutePageModule.
          page: () =>
            import("../components/a-page.js").then((module) =>
              adminRoutePageModule(module.APage),
            ),
        },
      ] }
    `
    expect(scanRouteContributions(source)[0]?.hasPage).toBe(true)
  })

  it("captures the raw validateSearch value", () => {
    const source = `
      const x = { routes: [
        { id: "a", path: "/a", component: A, validateSearch: (search) => fooSchema.parse(search) },
      ] }
    `
    expect(scanRouteContributions(source)[0]?.validateSearchRaw).toBe(
      "(search) => fooSchema.parse(search)",
    )
  })

  it("anchors on the routes array in code, not in doc-comment prose", () => {
    const source = `
      /**
       * ROUTES: contributions carry implementations, e.g. routes: [ ... ].
       */
      export function createFooAdminExtension() {
        return { id: "foo", routes: [{ id: "foo-index", path: "/foo", component: Foo }] }
      }
    `
    expect(scanRouteContributions(source).map((route) => route.id)).toEqual(["foo-index"])
  })
})

describe("scanRouteContributions — redirect contributions (RFC #1643 final sweep)", () => {
  const REDIRECT_SOURCE = `
export function createCatalogishAdminExtension(options = {}) {
  const { basePath = "/catalogish" } = options
  return defineAdminExtension({
    id: "catalogish",
    routes: [
      {
        // Index redirect (formerly a host file route).
        id: "catalogish-index",
        path: basePath,
        title: "Catalog",
        redirectTo: \`\${basePath}/products\`,
      },
      { id: "catalogish-literal", path: "/x", title: "X", redirectTo: "/x/y" },
      { id: "catalogish-unresolvable", path: "/y", title: "Y", redirectTo: options.somewhere },
    ],
  })
}
`

  it("extracts redirectTo, template-literal-resolved like path", () => {
    const [index, literal, unresolvable] = scanRouteContributions(REDIRECT_SOURCE)
    expect(index).toMatchObject({
      id: "catalogish-index",
      path: "/catalogish",
      hasRedirectTo: true,
      redirectTo: "/catalogish/products",
    })
    expect(literal).toMatchObject({ hasRedirectTo: true, redirectTo: "/x/y" })
    expect(unresolvable).toMatchObject({ hasRedirectTo: true, redirectTo: null })
  })

  it("counts redirect-only contributions as implemented", () => {
    const routes = scanRouteContributions(REDIRECT_SOURCE)
    expect(routes.map((route) => isImplementedContribution(route))).toEqual([true, true, true])
  })

  it("leaves hasRedirectTo false without the key", () => {
    const [route] = scanRouteContributions(PROMOTIONS_LIKE_SOURCE)
    expect(route).toMatchObject({ hasRedirectTo: false, redirectTo: null })
  })
})

const NESTED_SOURCE = `
export function createCoreishAdminExtension(options = {}) {
  const { basePath = "/settings" } = options
  return defineAdminExtension({
    id: "coreish",
    routes: [
      { id: "coreish-dashboard", path: "/", title: "Dashboard", page: () => import("./d.js") },
      {
        id: "coreish-settings",
        path: basePath,
        title: "Settings",
        page: () => import("./settings-layout.js"),
        children: [
          {
            id: "coreish-settings-index",
            path: "/",
            title: "Settings",
            redirectTo: \`\${basePath}/team\`,
          },
          { id: "coreish-settings-team", path: "/team", title: "Team", page: () => import("./t.js") },
          // Runtime-known children are spread in — invisible to the scanner.
          ...extraPages.map((page) => ({ id: page.id, path: page.path, page: page.page })),
        ],
      },
    ],
  })
}
`

describe("scanRouteContributions — nested children", () => {
  it("descends into children arrays (parent-relative paths, '/' = index)", () => {
    const [dashboard, settings] = scanRouteContributions(NESTED_SOURCE)
    expect(dashboard?.children).toBeNull()
    expect(settings?.id).toBe("coreish-settings")
    expect(settings?.path).toBe("/settings")
    const children = settings?.children
    expect(children?.map((child) => child.id)).toEqual([
      "coreish-settings-index",
      "coreish-settings-team",
    ])
    expect(children?.[0]).toMatchObject({
      path: "/",
      hasRedirectTo: true,
      redirectTo: "/settings/team",
    })
    expect(children?.[1]).toMatchObject({ path: "/team", hasPage: true })
    expect(children?.map((child) => isImplementedContribution(child))).toEqual([true, true])
  })

  it("treats a non-literal children value as a leaf (no static children)", () => {
    const source = `
      const x = { routes: [{ id: "a", path: "/a", page: () => import("./a.js"), children: kids }] }
    `
    expect(scanRouteContributions(source)[0]?.children).toBeNull()
  })
})

describe("collectContributionRoutePaths", () => {
  it("resolves child paths against the parent and skips index children and '/'", () => {
    const contributions = scanRouteContributions(NESTED_SOURCE)
    expect(collectContributionRoutePaths(contributions).sort()).toEqual([
      "/settings",
      "/settings/team",
    ])
  })

  it("skips contributions whose path is not statically resolvable", () => {
    const source = `
      const x = { routes: [{ id: "a", path: somewhere, page: () => import("./a.js") }] }
    `
    expect(collectContributionRoutePaths(scanRouteContributions(source))).toEqual([])
  })
})

describe("scanExtensionId", () => {
  it("reads the top-level id literal of defineAdminExtension", () => {
    expect(scanExtensionId(PROMOTIONS_LIKE_SOURCE)).toBe("foo")
  })

  it("ignores nested ids (nav items, route contributions)", () => {
    const source = `
      export function createBarAdminExtension() {
        return defineAdminExtension({
          navigation: [{ items: [{ id: "nav-bar" }] }],
          id: "bar",
          routes: [{ id: "bar-index", path: "/bar" }],
        })
      }
    `
    expect(scanExtensionId(source)).toBe("bar")
  })

  it("returns null without a defineAdminExtension call", () => {
    expect(scanExtensionId(`export const x = { id: "nope" }`)).toBeNull()
  })
})

describe("resolveSearchSchemaIdent", () => {
  const SOURCE = `
    import { z } from "zod"
    export { type CatalogSearchParams, catalogSearchSchema } from "../index.js"
    export const fooSchema = z.object({})
    const browseSearch = (search: Record<string, unknown>) => catalogSearchSchema.parse(search)
    const detailSearch = (search: Record<string, unknown>) =>
      localOnlySchema.parse(search)
  `

  it("resolves an inline parse arrow to its exported schema", () => {
    expect(resolveSearchSchemaIdent("(search) => fooSchema.parse(search)", SOURCE)).toBe(
      "fooSchema",
    )
  })

  it("resolves a directly exported schema identifier", () => {
    expect(resolveSearchSchemaIdent("fooSchema", SOURCE)).toBe("fooSchema")
  })

  it("follows one local helper alias to a re-exported schema", () => {
    expect(resolveSearchSchemaIdent("browseSearch", SOURCE)).toBe("catalogSearchSchema")
  })

  it("returns null when the schema is not exported from the entry", () => {
    expect(resolveSearchSchemaIdent("detailSearch", SOURCE)).toBeNull()
    expect(resolveSearchSchemaIdent("(s) => privateSchema.parse(s)", SOURCE)).toBeNull()
  })

  it("returns null for unresolvable expressions", () => {
    expect(resolveSearchSchemaIdent("zodToSearch(z.object({}))", SOURCE)).toBeNull()
  })
})

describe("isExportedIdent", () => {
  it("matches direct and brace exports, skipping type-only entries", () => {
    const source = `
      export const a = 1
      export function b() {}
      export { c, type D, e as f } from "./x.js"
    `
    expect(isExportedIdent(source, "a")).toBe(true)
    expect(isExportedIdent(source, "b")).toBe(true)
    expect(isExportedIdent(source, "c")).toBe(true)
    expect(isExportedIdent(source, "D")).toBe(false)
    expect(isExportedIdent(source, "f")).toBe(true)
    expect(isExportedIdent(source, "e")).toBe(false)
    expect(isExportedIdent(source, "nope")).toBe(false)
  })
})

describe("destination bindings — unresolvable param maps", () => {
  it("skips a binding whose destinationParams is not an object literal", () => {
    const source = `
declare module "@voyant-travel/admin" {
  interface AdminDestinations {
    "foo.detail": { fooId: string }
  }
}
const PARAM_MAP = { id: "fooId" }
export function createFooAdminExtension() {
  return {
    id: "foo",
    routes: [
      {
        id: "foo-detail",
        path: "/foo/$id",
        title: "Foo",
        component: FooDetail,
        destination: "foo.detail",
        destinationParams: PARAM_MAP,
      },
    ],
  }
}
`
    const { bindings, notes } = collectDestinationBindings([
      { importSpec: "@voyant-travel/foo-react/admin", source },
    ])
    expect(bindings).toHaveLength(0)
    expect(notes.join("\n")).toContain("not a statically-resolvable object literal")
  })
})

describe("scanGeneratedModuleRoutePaths", () => {
  it("reconstructs absolute paths for nested createRoute trees", () => {
    const source = `
      const workspace = () => WorkspaceRoute
      export const CoreSettingsRoute = createRoute({
        getParentRoute: workspace,
        path: "/settings",
        ...adminExtensionRouteOptions(coreExtension, "core-settings", runtime),
      })
      const coreSettings = () => CoreSettingsRoute
      export const CoreSettingsIndexRoute = createRoute({
        getParentRoute: coreSettings,
        path: "/",
        ...adminExtensionRouteOptions(coreExtension, "core-settings-index", runtime),
      })
      export const CoreSettingsTeamRoute = createRoute({
        getParentRoute: coreSettings,
        path: "/team",
        ...adminExtensionRouteOptions(coreExtension, "core-settings-team", runtime),
      })
    `
    const paths = scanGeneratedModuleRoutePaths(source)
    expect(paths).toContain("/settings")
    expect(paths).toContain("/settings/")
    expect(paths).toContain("/settings/team")
  })

  it("collects the path literals of createRoute calls", () => {
    const source = `
      export const PromotionsIndexRoute = createRoute({
        getParentRoute: workspace,
        path: "/promotions",
        ...adminExtensionRouteOptions(promotionsExtension, "promotions-index", runtime),
      })
      export const BookingsDetailRoute = createRoute({
        getParentRoute: workspace,
        path: "/bookings/$id",
        ...adminExtensionRouteOptions(bookingsExtension, "bookings-detail", runtime),
      })
    `
    expect(scanGeneratedModuleRoutePaths(source).sort()).toEqual(["/bookings/$id", "/promotions"])
  })
})

describe("resolveAdminRoutesManifestConfig", () => {
  it("fills operator defaults when the manifest has no admin.routes block", () => {
    const resolved = resolveAdminRoutesManifestConfig({})
    expect(resolved.dir).toBeUndefined()
    expect(resolved.out).toBeUndefined()
    expect(resolved.imports).toEqual(DEFAULT_ROUTES_MODULE_IMPORTS)
  })

  it("honors per-key overrides", () => {
    const resolved = resolveAdminRoutesManifestConfig({
      admin: {
        routes: {
          dir: "app/routes/admin",
          out: "app/admin.routes.gen.tsx",
          registryModule: "~/admin/registry",
          registryExport: "registry",
        },
      },
    })
    expect(resolved.dir).toBe("app/routes/admin")
    expect(resolved.out).toBe("app/admin.routes.gen.tsx")
    expect(resolved.imports.registryModule).toBe("~/admin/registry")
    expect(resolved.imports.registryExport).toBe("registry")
    expect(resolved.imports.apiUrlModule).toBe("@/lib/env")
  })
})

describe("scanDeclaredDestinationKeys", () => {
  it("extracts quoted keys from AdminDestinations declaration-merging blocks", () => {
    const source = `
      declare module "@voyant-travel/admin" {
        interface AdminDestinations {
          /** The list page. */
          "foo.list": Record<string, never>
          "foo.detail": { fooId: string }
          "foo.optional"?: { maybe?: string }
        }
      }
    `
    expect(scanDeclaredDestinationKeys(source).sort()).toEqual([
      "foo.detail",
      "foo.list",
      "foo.optional",
    ])
  })

  it("ignores quoted strings outside the interface and other modules", () => {
    const source = `
      const slot = { slot: "booking.details.header" }
      declare module "@voyant-travel/other" {
        interface AdminDestinations { "nope.key": {} }
      }
    `
    expect(scanDeclaredDestinationKeys(source)).toEqual([])
  })
})

describe("scanResolverMapKeys", () => {
  it("extracts keys of the object marked satisfies AdminDestinationResolvers", () => {
    const source = `
      export const destinations = {
        "foo.list": () => "/foo",
        "foo.detail": ({ fooId }) => \`/foo/\${encodeURIComponent(fooId)}\`,
      } satisfies AdminDestinationResolvers
    `
    expect(scanResolverMapKeys(source)?.sort()).toEqual(["foo.detail", "foo.list"])
  })

  it("returns null when no satisfies-marked map exists", () => {
    expect(scanResolverMapKeys(`export const x = { "a.b": () => "/x" }`)).toBeNull()
  })

  it("does not treat strings inside resolver bodies as keys", () => {
    const source = `
      const map = {
        "foo.list": () => "/foo" + "?tab=all",
      } satisfies AdminDestinationResolvers
    `
    expect(scanResolverMapKeys(source)).toEqual(["foo.list"])
  })
})

describe("route file paths", () => {
  it("derives the createFileRoute id from the routes dir", () => {
    expect(fileRouteIdFor("src/routes/_workspace", "/promotions")).toBe("/_workspace/promotions/")
    expect(fileRouteIdFor("src/routes", "/promotions")).toBe("/promotions/")
    expect(fileRouteIdFor("src/routes/_workspace", "/legal/templates")).toBe(
      "/_workspace/legal/templates/",
    )
  })

  it("derives the canonical generated file path", () => {
    expect(canonicalRouteFileRelPath("/legal/templates")).toBe("legal/templates/index.tsx")
  })

  it("does not treat the layout's route.tsx as a binding for the root path", () => {
    // `/` is the workspace's index child (e.g. the core dashboard) — only
    // index spellings may eject it, never the layout's own route.tsx.
    expect(alternativeRouteFileRelPaths("/")).toEqual(["index.ts"])
  })
})

describe("renderRouteFile", () => {
  const baseOptions = {
    fileRouteId: "/_workspace/promotions/",
    importSpec: "@voyant-travel/promotions-react/admin",
    exportName: "createPromotionsAdminExtension",
    routeId: "promotions-index",
    ssr: "data-only" as const,
    preload: null,
    hasLoader: true,
    hasValidateSearch: false,
    runtime: {
      apiUrlModule: "@/lib/env",
      apiUrlExport: "getApiUrl",
      fetcherModule: "@/lib/voyant-fetcher",
      fetcherExport: "operatorFetcher",
    },
  }

  it("renders a generator-owned thin host with the app runtime bound", () => {
    const content = renderRouteFile(baseOptions)
    expect(isGeneratedRouteFile(content)).toBe(true)
    expect(content).toContain(GENERATED_ROUTE_HEADER)
    expect(content).toContain(
      `import { createPromotionsAdminExtension } from "@voyant-travel/promotions-react/admin"`,
    )
    expect(content).toContain(`import { requireAdminRoute } from "@voyant-travel/admin"`)
    expect(content).toContain(
      `const route = requireAdminRoute(createPromotionsAdminExtension(), "promotions-index")`,
    )
    expect(content).toContain(`createFileRoute("/_workspace/promotions/")`)
    expect(content).toContain(`ssr: "data-only",`)
    expect(content).toContain(`runtime: { baseUrl: getApiUrl(), fetcher: operatorFetcher },`)
    expect(content).toContain(`component: RouteComponent,`)
    expect(content).not.toContain("validateSearch")
  })

  it("omits loader bindings (and their runtime imports) for loaderless routes", () => {
    const content = renderRouteFile({ ...baseOptions, hasLoader: false, ssr: null })
    expect(content).not.toContain("loader:")
    expect(content).not.toContain("@/lib/env")
    expect(content).not.toContain("ssr:")
  })

  it("binds validateSearch and preload when present", () => {
    const content = renderRouteFile({
      ...baseOptions,
      hasValidateSearch: true,
      preload: "intent",
    })
    expect(content).toContain(`validateSearch: route.validateSearch,`)
    expect(content).toContain(`preload: "intent",`)
  })
})

describe("code-assembled module derivations", () => {
  it("derives the route-id prefix from the routes dir", () => {
    expect(routeIdPrefixFor("src/routes/_workspace")).toBe("/_workspace")
    expect(routeIdPrefixFor("src/routes")).toBe("")
    expect(routeIdPrefixFor("app/routes/admin")).toBe("/admin")
  })

  it("derives the workspace layout route module from the routes dir", () => {
    expect(workspaceRouteModuleFor("src/routes/_workspace")).toBe("@/routes/_workspace/route")
    expect(workspaceRouteModuleFor("app/routes/admin")).toBe("@/app/routes/admin/route")
  })
})

describe("renderAdminRoutesModule", () => {
  const options = {
    moduleBaseName: "admin.routes.generated",
    imports: DEFAULT_ROUTES_MODULE_IMPORTS,
    workspaceRouteModule: "@/routes/_workspace/route",
    routeIdPrefix: "/_workspace",
    sections: [
      {
        extensionId: "bookings",
        importSpec: "@voyant-travel/bookings-react/admin",
        routes: [
          {
            constName: "BookingsIndexRoute",
            routeId: "bookings-index",
            path: "/bookings",
            searchSchemaIdent: "bookingsIndexSearchSchema",
          },
          {
            constName: "BookingsDetailRoute",
            routeId: "bookings-detail",
            path: "/bookings/$id",
            searchSchemaIdent: "bookingDetailSearchSchema",
          },
        ],
      },
      {
        extensionId: "notifications",
        importSpec: "@voyant-travel/notifications-react/admin",
        routes: [
          {
            constName: "NotificationsReminderRulesIndexRoute",
            routeId: "notifications-reminder-rules-index",
            path: "/notifications/reminder-rules",
            searchSchemaIdent: null,
          },
        ],
      },
    ],
  }

  it("renders the generator-owned module with registry-resolved route options", () => {
    const content = renderAdminRoutesModule(options)
    expect(isGeneratedRouteFile(content)).toBe(true)
    expect(content).toContain(`${GENERATED_ROUTE_HEADER} — do not edit.`)
    expect(content).toContain(`import { createRoute } from "@tanstack/react-router"`)
    expect(content).toContain(`import { adminExtensionRouteOptions } from "@voyant-travel/admin-app"`)
    expect(content).toContain(`import { adminExtensions } from "@/lib/admin-extensions"`)
    expect(content).toContain(`import { Route as WorkspaceRoute } from "@/routes/_workspace/route"`)
    expect(content).toContain(
      "const runtime = () => ({ baseUrl: getApiUrl(), fetcher: operatorFetcher })",
    )
    expect(content).toContain(`const bookingsExtension = extension("bookings")`)
    expect(content).toContain("export const BookingsIndexRoute = createRoute({")
    expect(content).toContain(`  path: "/bookings",`)
    expect(content).toContain("  validateSearch: bookingsIndexSearchSchema,")
    expect(content).toContain(
      `  ...adminExtensionRouteOptions(bookingsExtension, "bookings-index", runtime),`,
    )
    // The error tag carries the module base name.
    expect(content).toContain(`[admin.routes.generated] No registered admin extension "\${id}".`)
  })

  it("wraps schema imports and route-option spreads past the 100-column width", () => {
    const content = renderAdminRoutesModule(options)
    // Two bookings schemas + the long module spec exceed 100 columns.
    expect(content).toContain(
      [
        "import {",
        "  bookingDetailSearchSchema,",
        "  bookingsIndexSearchSchema,",
        `} from "@voyant-travel/bookings-react/admin"`,
      ].join("\n"),
    )
    expect(content).toContain(
      [
        "  ...adminExtensionRouteOptions(",
        "    notificationsExtension,",
        `    "notifications-reminder-rules-index",`,
        "    runtime,",
        "  ),",
      ].join("\n"),
    )
    for (const line of content.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100)
    }
  })

  it("emits the route tree and the three typed-link map interfaces", () => {
    const content = renderAdminRoutesModule(options)
    expect(content).toContain(
      [
        "export const adminExtensionRoutes = [",
        "  BookingsIndexRoute,",
        "  BookingsDetailRoute,",
        "  NotificationsReminderRulesIndexRoute,",
        "]",
      ].join("\n"),
    )
    expect(content).toContain("export interface AdminExtensionRoutesByFullPath {")
    expect(content).toContain("export interface AdminExtensionRoutesByTo {")
    expect(content).toContain("export interface AdminExtensionRoutesById {")
    expect(content).toContain(`  "/bookings/$id": typeof BookingsDetailRoute`)
    expect(content).toContain(`  "/_workspace/bookings/$id": typeof BookingsDetailRoute`)
    expect(content.endsWith("}\n")).toBe(true)
  })
})

describe("renderAdminRoutesModule — nested subtrees (core-extension shape)", () => {
  const options = {
    moduleBaseName: "admin.routes.generated",
    imports: DEFAULT_ROUTES_MODULE_IMPORTS,
    workspaceRouteModule: "@/routes/_workspace/route",
    routeIdPrefix: "/_workspace",
    sections: [
      {
        extensionId: "core",
        importSpec: "@voyant-travel/admin-app/core-extension",
        routes: [
          {
            constName: "CoreDashboardRoute",
            routeId: "core-dashboard",
            path: "/",
            searchSchemaIdent: null,
          },
          {
            constName: "CoreSettingsRoute",
            routeId: "core-settings",
            path: "/settings",
            searchSchemaIdent: null,
            children: [
              {
                constName: "CoreSettingsIndexRoute",
                routeId: "core-settings-index",
                path: "/",
                searchSchemaIdent: null,
              },
              {
                constName: "CoreSettingsTeamRoute",
                routeId: "core-settings-team",
                path: "/team",
                searchSchemaIdent: null,
              },
            ],
            subtreeComment: [
              "// Settings subtree: the static children above keep literal paths for typed",
              "// links; app-supplied extra settings pages (factory `settings.extraPages`,",
              "// invisible to the generator) bind at runtime via adminExtensionChildRoutes.",
            ],
          },
        ],
      },
    ],
  }
  const content = renderAdminRoutesModule(options)

  it("imports adminExtensionChildRoutes alongside adminExtensionRouteOptions", () => {
    expect(content).toContain(
      `import { adminExtensionChildRoutes, adminExtensionRouteOptions } from "@voyant-travel/admin-app"`,
    )
  })

  it("emits the parent, an accessor thunk, children with getParentRoute, and addChildren", () => {
    expect(content).toContain(
      [
        "const coreSettings = () => CoreSettingsRoute",
        "",
        "export const CoreSettingsIndexRoute = createRoute({",
        "  getParentRoute: coreSettings,",
        `  path: "/",`,
        `  ...adminExtensionRouteOptions(coreExtension, "core-settings-index", runtime),`,
        "})",
      ].join("\n"),
    )
    expect(content).toContain(
      [
        "// Settings subtree: the static children above keep literal paths for typed",
        "// links; app-supplied extra settings pages (factory `settings.extraPages`,",
        "// invisible to the generator) bind at runtime via adminExtensionChildRoutes.",
        "export const CoreSettingsRouteWithChildren = CoreSettingsRoute.addChildren([",
        "  CoreSettingsIndexRoute,",
        "  CoreSettingsTeamRoute,",
        `  ...adminExtensionChildRoutes(coreExtension, "core-settings", coreSettings, runtime, {`,
        "    exclude: [",
        `      "/",`,
        `      "/team",`,
        "    ],",
        "  }),",
        "])",
      ].join("\n"),
    )
  })

  /** Options with a single core-settings-like parent and the given children. */
  function nestedOptions(
    children: ReadonlyArray<{ constName: string; routeId: string; path: string }>,
    subtreeComment?: ReadonlyArray<string>,
  ): Parameters<typeof renderAdminRoutesModule>[0] {
    return {
      moduleBaseName: "admin.routes.generated",
      imports: DEFAULT_ROUTES_MODULE_IMPORTS,
      workspaceRouteModule: "@/routes/_workspace/route",
      routeIdPrefix: "/_workspace",
      sections: [
        {
          extensionId: "core",
          importSpec: "@voyant-travel/admin-app/core-extension",
          routes: [
            {
              constName: "CoreSettingsRoute",
              routeId: "core-settings",
              path: "/settings",
              searchSchemaIdent: null,
              children: children.map((child) => ({ ...child, searchSchemaIdent: null })),
              subtreeComment,
            },
          ],
        },
      ],
    }
  }

  it("expands the exclude list past the 100-column width (reference style)", () => {
    const longChildren = [
      "/",
      "/team",
      "/api-tokens",
      "/channels",
      "/taxes",
      "/cost-categories",
      "/pricing-categories",
      "/price-catalogs",
      "/product-types",
      "/product-tags",
    ]
    const expanded = renderAdminRoutesModule(
      nestedOptions(
        longChildren.map((path, index) => ({
          constName: `Child${index}Route`,
          routeId: `core-settings-${index}`,
          path,
        })),
      ),
    )
    expect(expanded).toContain(
      [
        `  ...adminExtensionChildRoutes(coreExtension, "core-settings", coreSettings, runtime, {`,
        "    exclude: [",
        `      "/",`,
        `      "/team",`,
        `      "/api-tokens",`,
        `      "/channels",`,
        `      "/taxes",`,
        `      "/cost-categories",`,
        `      "/pricing-categories",`,
        `      "/price-catalogs",`,
        `      "/product-types",`,
        `      "/product-tags",`,
        "    ],",
        "  }),",
        "])",
      ].join("\n"),
    )
  })

  it("falls back to a generic subtree comment when none is supplied", () => {
    const generic = renderAdminRoutesModule(
      nestedOptions([
        { constName: "CoreSettingsTeamRoute", routeId: "core-settings-team", path: "/team" },
      ]),
    )
    expect(generic).toContain(
      "// core-settings subtree: the static children above keep literal paths",
    )
  })

  it("references the WithChildren const in the tree array (children excluded)", () => {
    expect(content).toContain(
      [
        "export const adminExtensionRoutes = [",
        "  CoreDashboardRoute,",
        "  CoreSettingsRouteWithChildren,",
        "]",
      ].join("\n"),
    )
  })

  it("emits the typed-link maps exactly as the nested reference shapes", () => {
    // ByFullPath: parent → WithChildren; index child claims the
    // trailing-slash key; other children absolute keys.
    expect(content).toContain(
      [
        "export interface AdminExtensionRoutesByFullPath {",
        `  "/": typeof CoreDashboardRoute`,
        `  "/settings": typeof CoreSettingsRouteWithChildren`,
        `  "/settings/": typeof CoreSettingsIndexRoute`,
        `  "/settings/team": typeof CoreSettingsTeamRoute`,
        "}",
      ].join("\n"),
    )
    // ByTo: the index child claims the PARENT key; no trailing-slash key.
    expect(content).toContain(
      [
        "export interface AdminExtensionRoutesByTo {",
        `  "/": typeof CoreDashboardRoute`,
        `  "/settings": typeof CoreSettingsIndexRoute`,
        `  "/settings/team": typeof CoreSettingsTeamRoute`,
        "}",
      ].join("\n"),
    )
    // ById: like ByFullPath with the workspace prefix.
    expect(content).toContain(
      [
        "export interface AdminExtensionRoutesById {",
        `  "/_workspace/": typeof CoreDashboardRoute`,
        `  "/_workspace/settings": typeof CoreSettingsRouteWithChildren`,
        `  "/_workspace/settings/": typeof CoreSettingsIndexRoute`,
        `  "/_workspace/settings/team": typeof CoreSettingsTeamRoute`,
        "}",
      ].join("\n"),
    )
  })

  it("keeps the parent's own key for ByTo when the subtree has no index child", () => {
    const noIndex = renderAdminRoutesModule(
      nestedOptions([
        { constName: "CoreSettingsTeamRoute", routeId: "core-settings-team", path: "/team" },
      ]),
    )
    expect(noIndex).toContain(
      [
        "export interface AdminExtensionRoutesByTo {",
        `  "/settings": typeof CoreSettingsRouteWithChildren`,
        `  "/settings/team": typeof CoreSettingsTeamRoute`,
        "}",
      ].join("\n"),
    )
  })

  it("imports child search schemas and round-trips through the module path scan", () => {
    const base = nestedOptions([])
    const withSchema = renderAdminRoutesModule({
      ...base,
      sections: [
        {
          extensionId: "core",
          importSpec: "@voyant-travel/admin-app/core-extension",
          routes: [
            {
              constName: "CoreSettingsRoute",
              routeId: "core-settings",
              path: "/settings",
              searchSchemaIdent: null,
              children: [
                {
                  constName: "CoreSettingsTeamRoute",
                  routeId: "core-settings-team",
                  path: "/team",
                  searchSchemaIdent: "teamSearchSchema",
                },
              ],
            },
          ],
        },
      ],
    })
    expect(withSchema).toContain(
      `import { teamSearchSchema } from "@voyant-travel/admin-app/core-extension"`,
    )
    expect(withSchema).toContain("  validateSearch: teamSearchSchema,")
    // The emitted nested module is readable back by the doctor's path scan.
    const paths = scanGeneratedModuleRoutePaths(withSchema)
    expect(paths).toContain("/settings")
    expect(paths).toContain("/settings/team")
  })
})

// ---------------------------------------------------------------------------
// Generated destination resolvers (packaged-admin RFC §4.7 endgame)
// ---------------------------------------------------------------------------

const DESTINATION_SOURCE = `
export function createSuppliersishAdminExtension(options = {}) {
  const { basePath = "/suppliersish", labels = {} } = options
  return defineAdminExtension({
    id: "suppliersish",
    routes: [
      {
        id: "suppliersish-index",
        path: basePath,
        title: "Suppliers",
        // Route-backed destination (RFC §4.7 endgame).
        destination: "supplierish.list",
        page: () => import("./suppliers-host.js"),
      },
      {
        id: "suppliersish-detail",
        path: \`\${basePath}/$id\`,
        title: "Suppliers",
        destination: "supplierish.detail",
        destinationParams: { id: "supplierId" },
        page: () => import("./pages/supplier-detail-page.js"),
      },
      {
        id: "suppliersish-notes",
        path: \`\${basePath}/$id/notes/$noteId\`,
        title: "Notes",
        destination: "supplierishNote.detail",
        destinationParams: { noteId: "supplierNoteId" },
        page: () => import("./pages/supplier-note-page.js"),
      },
      {
        id: "suppliersish-plain",
        path: \`\${basePath}/plain\`,
        title: "Plain",
        page: () => import("./pages/plain.js"),
      },
    ],
  })
}
`

describe("scanRouteContributions — destination annotations", () => {
  it("extracts destination keys and param maps", () => {
    const routes = scanRouteContributions(DESTINATION_SOURCE)
    expect(routes.map((route) => route.destination)).toEqual([
      "supplierish.list",
      "supplierish.detail",
      "supplierishNote.detail",
      null,
    ])
    expect(routes[1]?.destinationParams).toEqual({ id: "supplierId" })
    expect(routes[2]?.destinationParams).toEqual({ noteId: "supplierNoteId" })
    // Absent map = undefined (identity mapping OK); null is reserved for
    // present-but-unresolvable literals, which must skip the binding.
    expect(routes[0]?.destinationParams).toBeUndefined()
  })

  it("treats a non-static destinationParams map as unresolvable", () => {
    const source = `
      routes: [
        { id: "x", path: "/x/$id", destination: "x.detail", destinationParams: { id: someIdent } },
      ],
    `
    const [route] = scanRouteContributions(source)
    expect(route?.destination).toBe("x.detail")
    expect(route?.destinationParams).toBeNull()
  })
})

describe("collectDestinationBindings", () => {
  it("collects annotated contributions sorted by key", () => {
    const { bindings, notes } = collectDestinationBindings([
      { importSpec: "@voyant-travel/suppliersish-react/admin", source: DESTINATION_SOURCE },
    ])
    expect(notes).toEqual([])
    expect(bindings.map((binding) => binding.key)).toEqual([
      "supplierish.detail",
      "supplierish.list",
      "supplierishNote.detail",
    ])
    expect(bindings[0]).toMatchObject({
      key: "supplierish.detail",
      path: "/suppliersish/$id",
      importSpec: "@voyant-travel/suppliersish-react/admin",
      params: { id: "supplierId" },
    })
  })

  it("notes and skips annotations with unresolvable paths", () => {
    const source = `
      routes: [
        { id: "x", path: somewhereElse, destination: "x.list" },
      ],
    `
    const { bindings, notes } = collectDestinationBindings([
      { importSpec: "@voyant-travel/x-react/admin", source },
    ])
    expect(bindings).toEqual([])
    expect(notes.join("\n")).toContain('skipped destination "x.list"')
    expect(notes.join("\n")).toContain("not statically resolvable")
  })

  it("keeps the first binding for a duplicated key and notes the duplicate", () => {
    const first = `routes: [{ id: "a", path: "/a", destination: "shared.list" }]`
    const second = `routes: [{ id: "b", path: "/b", destination: "shared.list" }]`
    const { bindings, notes } = collectDestinationBindings([
      { importSpec: "@voyant-travel/a-react/admin", source: first },
      { importSpec: "@voyant-travel/b-react/admin", source: second },
    ])
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.path).toBe("/a")
    expect(notes.join("\n")).toContain('skipped duplicate destination "shared.list"')
    expect(notes.join("\n")).toContain("@voyant-travel/a-react/admin /a")
  })
})

describe("renderAdminDestinationsModule", () => {
  const { bindings } = collectDestinationBindings([
    { importSpec: "@voyant-travel/suppliersish-react/admin", source: DESTINATION_SOURCE },
  ])
  const content = renderAdminDestinationsModule({
    bindings,
    importSpecs: ["@voyant-travel/suppliersish-react/admin", "@voyant-travel/other-react/admin"],
  })

  it("emits the generated header and the ejection contract", () => {
    expect(isGeneratedDestinationsFile(content)).toBe(true)
    expect(content).toContain(`${GENERATED_DESTINATIONS_HEADER} — do not edit.`)
    expect(content).toContain("To eject the whole map, delete this header")
  })

  it("binds every admin entry's augmentations type-only, sorted", () => {
    const otherIndex = content.indexOf(`import type {} from "@voyant-travel/other-react/admin"`)
    const suppliersIndex = content.indexOf(
      `import type {} from "@voyant-travel/suppliersish-react/admin"`,
    )
    expect(otherIndex).toBeGreaterThan(-1)
    expect(suppliersIndex).toBeGreaterThan(otherIndex)
    expect(content).toContain(`import type { AdminDestinationResolvers } from "@voyant-travel/admin"`)
  })

  it("emits param-less resolvers as plain string returns", () => {
    expect(content).toContain(`"supplierish.list": () => "/suppliersish",`)
  })

  it("emits path interpolation with encodeURIComponent and mapped param names", () => {
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted template-literal source
      '"supplierish.detail": ({ supplierId }) => `/suppliersish/${encodeURIComponent(supplierId)}`,',
    )
    // Unmapped params keep their route name; mapped ones rename.
    expect(content).toContain('"supplierishNote.detail": ({ id, supplierNoteId }) =>')
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted template-literal source
      "`/suppliersish/${encodeURIComponent(id)}/notes/${encodeURIComponent(supplierNoteId)}`,",
    )
  })

  it("closes with the Partial satisfies marker scanGeneratedDestinationKeys reads", () => {
    expect(content).toContain("} satisfies Partial<AdminDestinationResolvers>")
    expect(scanGeneratedDestinationKeys(content)).toEqual([
      "supplierish.detail",
      "supplierish.list",
      "supplierishNote.detail",
    ])
  })

  it("is deterministic", () => {
    expect(
      renderAdminDestinationsModule({
        bindings,
        importSpecs: ["@voyant-travel/other-react/admin", "@voyant-travel/suppliersish-react/admin"],
      }),
    ).toBe(content)
  })
})

describe("scanGeneratedDestinationKeys", () => {
  it("returns null when no Partial-satisfies map exists", () => {
    expect(scanGeneratedDestinationKeys(`export const x = { "a.b": () => "/a" }`)).toBeNull()
    expect(
      scanGeneratedDestinationKeys(
        `export const x = { "a.b": () => "/a" } satisfies AdminDestinationResolvers`,
      ),
    ).toBeNull()
  })

  it("returns the empty list for an empty generated map", () => {
    expect(
      scanGeneratedDestinationKeys(
        `export const x = {} satisfies Partial<AdminDestinationResolvers>`,
      ),
    ).toEqual([])
  })
})
