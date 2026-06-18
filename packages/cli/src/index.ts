import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { adminCommand } from "./commands/admin.js"
import { appsCommand } from "./commands/apps.js"
import { configCommand } from "./commands/config.js"
import { databasesCommand } from "./commands/databases.js"
import { dbCommand } from "./commands/db.js"
import { deployCommand } from "./commands/deploy.js"
import { devCommand } from "./commands/dev-command.js"
import { doctorCommand } from "./commands/doctor.js"
import { envCommand } from "./commands/env.js"
import { execCommand } from "./commands/exec.js"
import { generateLinkCommand } from "./commands/generate-link.js"
import { generateModuleCommand } from "./commands/generate-module.js"
import { helpCommand } from "./commands/help.js"
import { loginCommand } from "./commands/login.js"
import { logoutCommand } from "./commands/logout.js"
import { logsCommand } from "./commands/logs.js"
import { newCommand } from "./commands/new.js"
import { orgCommand } from "./commands/org.js"
import { secretsCommand } from "./commands/secrets.js"
import { storageCommand } from "./commands/storage.js"
import { upgradeCommand } from "./commands/upgrade.js"
import { vaultsCommand } from "./commands/vaults.js"
import { whoamiCommand } from "./commands/whoami.js"
import { workflowsCommand } from "./commands/workflows-command.js"
import type { CommandContext, CommandResult } from "./types.js"

export type { CommandContext, CommandResult } from "./types.js"

export interface MainOptions {
  cwd?: string
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

/**
 * Entry point for the `voyant` CLI. Dispatches to subcommands.
 *
 * @param argv - arguments following the binary name (i.e. `process.argv.slice(2)`)
 * @param opts - overrides for cwd + stdout/stderr streams (useful in tests)
 * @returns the intended process exit code (0 on success)
 */
export async function main(
  argv: ReadonlyArray<string>,
  opts: MainOptions = {},
): Promise<CommandResult> {
  const ctx: CommandContext = {
    argv,
    cwd: opts.cwd ?? process.cwd(),
    stdout: opts.stdout ?? ((chunk) => process.stdout.write(chunk)),
    stderr: opts.stderr ?? ((chunk) => process.stderr.write(chunk)),
  }

  const [head, ...rest] = argv
  if (!head || head === "--help" || head === "-h" || head === "help") {
    return helpCommand(ctx)
  }

  if (head === "--version" || head === "-v" || head === "version") {
    ctx.stdout(`${await readCliVersion()}\n`)
    return 0
  }

  switch (head) {
    case "generate": {
      const [sub, ...subArgs] = rest
      const subCtx = { ...ctx, argv: subArgs }
      if (sub === "module") return generateModuleCommand(subCtx)
      if (sub === "link") return generateLinkCommand(subCtx)
      ctx.stderr(`Unknown generate subcommand: ${sub ?? "(none)"}. Expected "module" or "link".\n`)
      return 1
    }
    case "config": {
      return configCommand({ ...ctx, argv: rest })
    }
    case "admin": {
      return adminCommand({ ...ctx, argv: rest })
    }
    case "doctor": {
      return doctorCommand({ ...ctx, argv: rest })
    }
    case "upgrade": {
      return upgradeCommand({ ...ctx, argv: rest })
    }
    case "new": {
      return newCommand({ ...ctx, argv: rest })
    }
    case "exec": {
      return execCommand({ ...ctx, argv: rest })
    }
    case "dev": {
      return devCommand({ ...ctx, argv: rest })
    }
    case "workflows": {
      return workflowsCommand({ ...ctx, argv: rest })
    }
    case "db": {
      return dbCommand({ ...ctx, argv: rest })
    }
    case "login": {
      return loginCommand({ ...ctx, argv: rest })
    }
    case "logout": {
      return logoutCommand({ ...ctx, argv: rest })
    }
    case "whoami": {
      return whoamiCommand({ ...ctx, argv: rest })
    }
    case "org": {
      return orgCommand({ ...ctx, argv: rest })
    }
    case "vaults": {
      return vaultsCommand({ ...ctx, argv: rest })
    }
    case "secrets": {
      return secretsCommand({ ...ctx, argv: rest })
    }
    case "logs": {
      return logsCommand({ ...ctx, argv: rest })
    }
    case "apps": {
      return appsCommand({ ...ctx, argv: rest })
    }
    case "env": {
      return envCommand({ ...ctx, argv: rest })
    }
    case "deploy": {
      return deployCommand({ ...ctx, argv: rest })
    }
    case "databases": {
      return databasesCommand({ ...ctx, argv: rest })
    }
    case "storage": {
      return storageCommand({ ...ctx, argv: rest })
    }
    case "build": {
      ctx.stderr(
        "voyant: use `voyant workflows build`. The top-level `voyant build` entry will wrap multiple build targets once the app/runtime layer is merged.\n",
      )
      return 1
    }
    case "db:generate":
    case "db:migrate":
    case "db:studio":
    case "db:push":
    case "db:check": {
      return dbCommand({ ...ctx, argv: [head.slice(3), ...rest] })
    }
    default: {
      ctx.stderr(`Unknown command: ${head}\n\n`)
      helpCommand(ctx)
      return 1
    }
  }
}

async function readCliVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgPath = resolve(here, "..", "package.json")
  const raw = await readFile(pkgPath, "utf8")
  return (JSON.parse(raw) as { version: string }).version
}
