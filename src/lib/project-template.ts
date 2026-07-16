import { createDirectory, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { getTemplate } from "@/lib/templates"

export async function materializeProjectTemplate(
  projectPath: string,
  templateId: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const template = getTemplate(templateId)

  await writeFile(`${pp}/schema.md`, template.schema)
  await writeFile(`${pp}/purpose.md`, template.purpose)
  for (const dir of template.extraDirs) {
    await createDirectory(`${pp}/${dir}`)
  }
}

