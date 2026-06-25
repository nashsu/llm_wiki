export function shouldHideNodeType(
  nodeType: string | undefined,
  hiddenTypes: ReadonlySet<string>,
): boolean {
  return nodeType !== undefined && hiddenTypes.has(nodeType)
}

export function shouldHideEdgeByNodeTypes(
  sourceType: string | undefined,
  targetType: string | undefined,
  hiddenTypes: ReadonlySet<string>,
): boolean {
  return shouldHideNodeType(sourceType, hiddenTypes) || shouldHideNodeType(targetType, hiddenTypes)
}
