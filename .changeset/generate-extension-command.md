---
"@voyant-travel/cli": minor
---

Add `voyant generate extension <name> --module <target>`. It scaffolds a deployment-local `HonoExtension` under `src/extensions/<name>/` that attaches to an existing module's surface — the counterpart to `voyant generate module`, for adding routes (and optionally a detail table) to a module like `bookings` without forking it.

Flags: `--module <target>` (required — the module the extension attaches to), `--public` (mount on `/v1/public` instead of `/v1/admin`), `--with-schema` (also emit a 1:1 extension table with a plain-text FK), plus `--dir` and `--force`. Generates `index.ts` (via `defineDeploymentExtension`), `routes.ts`, `validation.ts`, and an optional `schema.ts` — no `package.json`/`tsconfig.json`, since an extension is not an npm package. Names that would produce an invalid TypeScript identifier are rejected before any files are written.
