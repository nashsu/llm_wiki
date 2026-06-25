export function cleanAssistantContentForWikiSave(content: string): string {
  return content
    .replace(/<!--\s*(?:save-worthy|sources):[^\n]*?-->/g, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
    .replace(/^\s+/, "")
    .trimEnd()
}

export function titleFromCleanAssistantContent(clean: string): string {
  const firstVisibleLine = clean
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0)
  return firstVisibleLine?.slice(0, 60) || "Saved Query"
}
