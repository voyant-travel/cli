import { parseArgs } from "../lib/args.js"
import type { StoredRun } from "../lib/run-store.js"
import { waitForShutdownSignal } from "../lib/shutdown.js"
import type { CommandContext, CommandResult } from "../types.js"
import { defaultBuildDeps, runWorkflowsBuild } from "./workflows/build-cmd.js"
import { defaultDeployDeps, runWorkflowsDeploy } from "./workflows/deploy.js"
import { defaultDoctorDeps, runWorkflowsDoctor } from "./workflows/doctor.js"
import { defaultListDeps, runWorkflowsList } from "./workflows/list.js"
import { defaultManifestDeps, runWorkflowsManifest } from "./workflows/manifest-cmd.js"
import { defaultPruneDeps, runWorkflowsPrune } from "./workflows/prune.js"
import { defaultReplayDeps, runWorkflowsReplay } from "./workflows/replay.js"
import { defaultRunDeps, runWorkflowsRun } from "./workflows/run.js"
import { defaultRunDetailDeps, runWorkflowsRunDetail } from "./workflows/run-detail.js"
import { defaultRunsDeps, runWorkflowsRuns } from "./workflows/runs.js"
import {
  defaultServeDeps,
  parseServeOptions,
  type ServeDeps,
  type ServeHandle,
  startServer,
} from "./workflows/serve.js"
import { defaultTailDeps, runWorkflowsTail } from "./workflows/tail.js"
import { defaultTriggerDeps, runWorkflowsTrigger } from "./workflows/trigger.js"

export interface WorkflowsCommandDeps {
  defaultServeDeps?: typeof defaultServeDeps
  startServer?: typeof startServer
  waitForShutdown?: (cleanup: () => Promise<void>) => Promise<void>
}

export async function workflowsCommand(
  ctx: CommandContext,
  commandDeps: WorkflowsCommandDeps = {},
): Promise<CommandResult> {
  const [subcommand, ...rest] = ctx.argv
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    ctx.stdout(`${WORKFLOWS_USAGE}\n`)
    return 0
  }

  const args = parseArgs(rest)
  const json = args.flags.json === true

  switch (subcommand) {
    case "list": {
      const outcome = await runWorkflowsList(args, await defaultListDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      if (json) {
        ctx.stdout(`${JSON.stringify(outcome.result, null, 2)}\n`)
      } else {
        printWorkflowsListHuman(ctx, outcome.result.workflows)
      }
      return 0
    }
    case "run": {
      const outcome = await runWorkflowsRun(args, await defaultRunDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stdout(`${JSON.stringify(outcome.result, null, 2)}\n`)
      if (outcome.saved) {
        ctx.stderr(`saved: ${outcome.saved.id}\n`)
      }
      return 0
    }
    case "runs": {
      const outcome = await runWorkflowsRuns(args, await defaultRunsDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      if (json) {
        ctx.stdout(`${JSON.stringify(outcome.runs, null, 2)}\n`)
      } else {
        printRunsHuman(ctx, outcome.runs)
      }
      return 0
    }
    case "run-detail": {
      const outcome = await runWorkflowsRunDetail(args, await defaultRunDetailDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stdout(`${JSON.stringify(outcome.run, null, 2)}\n`)
      return 0
    }
    case "serve": {
      if (args.flags.help === true || args.flags.h === true) {
        ctx.stdout(`${WORKFLOWS_SERVE_USAGE}\n`)
        return 0
      }

      const parsed = parseServeOptions(args)
      if (!parsed.ok) {
        ctx.stderr(`${parsed.message}\n`)
        return parsed.exitCode
      }
      const dashboardOverride =
        typeof args.flags.dashboard === "string" ? args.flags.dashboard : undefined
      const entryFile = typeof args.flags.file === "string" ? args.flags.file : undefined

      let serveDeps: ServeDeps
      try {
        serveDeps = await (commandDeps.defaultServeDeps ?? defaultServeDeps)({
          staticDir: dashboardOverride,
          entryFile,
        })
      } catch (err) {
        ctx.stderr(
          `voyant workflows serve: failed to load --file: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
        return 1
      }

      let handle: ServeHandle
      try {
        handle = await (commandDeps.startServer ?? startServer)(parsed.options, serveDeps)
        ctx.stderr(`voyant workflows serve: listening at ${handle.url}\n`)
        if (serveDeps.staticDir) {
          ctx.stderr(`  dashboard served from ${serveDeps.staticDir}\n`)
        } else {
          ctx.stderr("  (dashboard bundle not found — serving JSON only)\n")
        }
        if (serveDeps.listWorkflows) {
          const count = serveDeps.listWorkflows().length
          ctx.stderr(`  ${count} workflow${count === 1 ? "" : "s"} registered from ${entryFile}\n`)
        }
        ctx.stderr(`  GET ${handle.url}/api/runs\n`)
        ctx.stderr(`  GET ${handle.url}/api/runs/:id\n`)
        if (serveDeps.triggerRun) {
          ctx.stderr(`  POST ${handle.url}/api/runs\n`)
          ctx.stderr(`  GET ${handle.url}/api/workflows\n`)
        }
        if (serveDeps.listSchedules) {
          const count = serveDeps.listSchedules().length
          if (count > 0) {
            ctx.stderr(
              `  ${count} schedule${count === 1 ? "" : "s"} loaded (${handle.url}/api/schedules)\n`,
            )
          }
        }
        ctx.stderr("Press Ctrl+C to stop.\n")
      } catch (err) {
        ctx.stderr(
          `voyant workflows serve: failed to start: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
        return 1
      }

      try {
        await (commandDeps.waitForShutdown ?? waitForShutdownSignal)(async () => {
          await handle.close()
        })
      } catch (err) {
        ctx.stderr(
          `voyant workflows serve: failed to stop: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
        return 1
      }
      return 0
    }
    case "replay": {
      const outcome = await runWorkflowsReplay(args, await defaultReplayDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stdout(`${JSON.stringify(outcome.result, null, 2)}\n`)
      if (outcome.saved) {
        ctx.stderr(`saved: ${outcome.saved.id} (replay of ${outcome.replayedFrom.id})\n`)
      }
      return 0
    }
    case "manifest": {
      const outcome = await runWorkflowsManifest(args, await defaultManifestDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      if (outcome.wrotePath) {
        ctx.stderr(`manifest written to ${outcome.wrotePath}\n`)
      } else {
        ctx.stdout(`${JSON.stringify(outcome.manifest, null, 2)}\n`)
      }
      return 0
    }
    case "build": {
      const outcome = await runWorkflowsBuild(args, await defaultBuildDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stderr(`bundle   → ${outcome.bundlePath}\n`)
      ctx.stderr(`manifest → ${outcome.manifestPath}\n`)
      return 0
    }
    case "deploy": {
      const outcome = await runWorkflowsDeploy(args, await defaultDeployDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stderr(`bundle   → ${outcome.result.bundlePath}\n`)
      ctx.stderr(`manifest → ${outcome.result.manifestPath}\n`)
      ctx.stderr(`staged   → ${outcome.result.stagedBundlePath}\n`)
      if (outcome.result.stagedConfigPath) {
        ctx.stderr(`config   → ${outcome.result.stagedConfigPath}\n`)
      }
      if (outcome.result.applied && outcome.result.applyCommand) {
        ctx.stderr(`applied  → ${outcome.result.applyCommand.join(" ")}\n`)
      } else {
        ctx.stderr(`next     → ${outcome.result.nextStep}\n`)
      }
      return 0
    }
    case "doctor": {
      const outcome = await runWorkflowsDoctor(args, await defaultDoctorDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      for (const check of outcome.result.checks) {
        ctx.stderr(`${check.ok ? "ok" : "err"}  ${check.id}  ${check.message}\n`)
      }
      return outcome.result.ok ? 0 : 1
    }
    case "trigger": {
      const outcome = await runWorkflowsTrigger(args, await defaultTriggerDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stdout(`${JSON.stringify(outcome.saved, null, 2)}\n`)
      const output = outcome.saved.result.output
      const outputPreview = output === undefined ? "" : ` · output: ${JSON.stringify(output)}`
      ctx.stderr(`triggered ${outcome.saved.id} (${outcome.saved.status})${outputPreview}\n`)
      return 0
    }
    case "prune": {
      const outcome = await runWorkflowsPrune(args, await defaultPruneDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      if (json) {
        ctx.stdout(`${JSON.stringify(outcome, null, 2)}\n`)
      } else if (outcome.dryRun) {
        ctx.stderr(
          `dry run — would delete ${outcome.candidates.length} run${
            outcome.candidates.length === 1 ? "" : "s"
          }\n`,
        )
        for (const run of outcome.candidates) {
          const started = new Date(run.startedAt).toISOString()
          ctx.stderr(`  ${run.id}  ${run.workflowId}  ${run.status}  ${started}\n`)
        }
      } else {
        ctx.stderr(
          `deleted ${outcome.deleted.length} run${
            outcome.deleted.length === 1 ? "" : "s"
          } from .voyant/runs\n`,
        )
      }
      return 0
    }
    case "tail": {
      const outcome = await runWorkflowsTail(args, await defaultTailDeps())
      if (!outcome.ok) {
        ctx.stderr(`${outcome.message}\n`)
        return outcome.exitCode
      }
      ctx.stderr(
        `\nrun ended (${outcome.terminalStatus}) · ${outcome.chunksPrinted} chunk${
          outcome.chunksPrinted === 1 ? "" : "s"
        }\n`,
      )
      return 0
    }
    case "logs":
    case "cancel":
    case "retry":
    case "inspect": {
      ctx.stderr(
        `voyant workflows ${subcommand}: talks to the cloud control plane, ` +
          "which lives in voyant-cloud. For local dev, use `voyant workflows serve` " +
          "+ the dashboard.\n",
      )
      return 1
    }
    default: {
      ctx.stderr(`voyant workflows: unknown subcommand "${subcommand}"\n`)
      ctx.stdout(`${WORKFLOWS_USAGE}\n`)
      return 1
    }
  }
}

function printWorkflowsListHuman(
  ctx: CommandContext,
  workflows: { id: string; description?: string; schedules: number; hasCompensation: boolean }[],
): void {
  if (workflows.length === 0) {
    ctx.stdout("(no workflows registered)\n")
    return
  }
  const idWidth = Math.max(...workflows.map((workflow) => workflow.id.length), 4)
  ctx.stdout(`${"ID".padEnd(idWidth)}  SCHEDULES  DESCRIPTION\n`)
  ctx.stdout(`${"-".repeat(idWidth)}  ---------  -----------\n`)
  for (const workflow of workflows) {
    ctx.stdout(
      `${workflow.id.padEnd(idWidth)}  ${String(workflow.schedules).padEnd(9)}  ${workflow.description ?? ""}\n`,
    )
  }
}

function printRunsHuman(ctx: CommandContext, runs: StoredRun[]): void {
  if (runs.length === 0) {
    ctx.stdout("(no saved runs)\n")
    return
  }
  const idWidth = Math.max(...runs.map((run) => run.id.length), 2)
  const wfWidth = Math.max(...runs.map((run) => run.workflowId.length), 8)
  ctx.stdout(
    `${"ID".padEnd(idWidth)}  ${"WORKFLOW".padEnd(wfWidth)}  STATUS              STARTED                   DURATION\n`,
  )
  ctx.stdout(
    `${"-".repeat(idWidth)}  ${"-".repeat(wfWidth)}  ------------------  ------------------------  ---------\n`,
  )
  for (const run of runs) {
    const started = new Date(run.startedAt).toISOString()
    const duration = run.durationMs !== undefined ? `${run.durationMs}ms` : "-"
    ctx.stdout(
      `${run.id.padEnd(idWidth)}  ${run.workflowId.padEnd(wfWidth)}  ${run.status.padEnd(18)}  ${started}  ${duration}\n`,
    )
  }
}

const WORKFLOWS_USAGE = `voyant workflows — inspect and run workflows

usage:
  voyant workflows list --file <path> [--json]
  voyant workflows run <id> --file <path> [--input <json>] [--input-file <path>] [--no-save]
  voyant workflows runs [--workflow <id>] [--status <s>] [--limit N] [--json]
  voyant workflows run-detail <run-id>
  voyant workflows replay <run-id> [--file <path>] [--no-save]
  voyant workflows serve [--port <n>] [--host <h>] [--file <path>] [--dashboard <path>]
  voyant workflows manifest --file <path> [--out <path>]
  voyant workflows build --file <path> [--out <dir>] [--platform neutral|node|browser] [--minify] [--no-sourcemap]
  voyant workflows deploy --target docker --file <path> [--out <dir>] [--apply]
                          [--host-port <n>] [--bind-port <n>] [--database-url <url>]
                          [--database-wait-seconds <n>] [--skip-migrations] [--env-out <path>]
  voyant workflows doctor --target docker [--env-file <path>] [--bundle <path>] [--check-docker]
  voyant workflows doctor --target entry --file <path>
  voyant workflows trigger <id> [--input <json>] [--input-file <path>] [--url <url>]
  voyant workflows prune [--older-than <duration>] [--keep <N>] [--workflow <id>] [--status <s>] [--dry-run] [--json]
  voyant workflows tail <run-id> [--url <url>] [--stream <streamId>] [--json]
`

const WORKFLOWS_SERVE_USAGE = `voyant workflows serve - serve workflows locally

usage:
  voyant workflows serve [--port <n>] [--host <h>] [--file <path>] [--dashboard <path>]
`
