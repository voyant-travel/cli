export function moduleIndexTs(name: string): string {
  return `import { defineDeploymentModule } from "@voyant-travel/framework"

export default defineDeploymentModule({
  module: { name: "${name}" },
})
`
}
