import { parseArgs } from "../lib/args.js"
import { toCamelCase } from "../lib/strings.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant generate link <leftModule>.<leftEntity> <rightModule>.<rightEntity>`
 *   `[--left-list] [--right-list] [--cascade]`
 *
 * Prints a TypeScript snippet for a `defineLink` declaration connecting two
 * linkable entities. The snippet uses placeholder imports the caller must
 * replace with the actual `linkable` exports from each module.
 */
export async function generateLinkCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const [left, right] = positionals
  if (!left || !right) {
    ctx.stderr(
      "Usage: voyant generate link <leftModule>.<leftEntity> <rightModule>.<rightEntity> " +
        "[--left-list] [--right-list] [--cascade]\n",
    )
    return 1
  }

  const parseRef = (ref: string): { module: string; entity: string } | null => {
    const idx = ref.indexOf(".")
    if (idx <= 0 || idx === ref.length - 1) return null
    return { module: ref.slice(0, idx), entity: ref.slice(idx + 1) }
  }

  const leftRef = parseRef(left)
  const rightRef = parseRef(right)
  if (!leftRef || !rightRef) {
    ctx.stderr(
      "Link sides must be of the form <module>.<entity> (e.g. crm.person products.product)\n",
    )
    return 1
  }

  const leftList = flags["left-list"] === true
  const rightList = flags["right-list"] === true
  const cascade = flags.cascade === true

  const linkVarName = `${toCamelCase(leftRef.entity)}${toCamelCase(rightRef.entity).replace(
    /^./,
    (c) => c.toUpperCase(),
  )}Link`

  const leftLinkableVar = `${toCamelCase(leftRef.entity)}Linkable`
  const rightLinkableVar = `${toCamelCase(rightRef.entity)}Linkable`

  const leftExpr = leftList ? `{ linkable: ${leftLinkableVar}, isList: true }` : leftLinkableVar
  const rightExpr = rightList ? `{ linkable: ${rightLinkableVar}, isList: true }` : rightLinkableVar

  const optionsArg = cascade ? ",\n  { deleteCascade: true }" : ""

  const snippet = `import { defineLink } from "@voyant-travel/core/links"
import { ${leftLinkableVar} } from "@voyant-travel/${leftRef.module}"
import { ${rightLinkableVar} } from "@voyant-travel/${rightRef.module}"

/**
 * ${leftRef.module}.${leftRef.entity} <-> ${rightRef.module}.${rightRef.entity} link.
 * Cardinality: ${cardinalityLabel(leftList, rightList)}
 */
export const ${linkVarName} = defineLink(
  ${leftExpr},
  ${rightExpr}${optionsArg},
)
`

  ctx.stdout(snippet)
  return 0
}

function cardinalityLabel(leftList: boolean, rightList: boolean): string {
  if (!leftList && !rightList) return "one-to-one"
  if (!leftList && rightList) return "one-to-many"
  if (leftList && !rightList) return "many-to-one"
  return "many-to-many"
}
