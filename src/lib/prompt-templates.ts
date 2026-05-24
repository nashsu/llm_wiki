export interface PromptTemplate {
  id: string
  name: string
  description: string
  systemPrompt: string
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "default",
    name: "Default",
    description: "Standard wiki assistant behavior",
    systemPrompt: `You are a knowledgeable assistant for a wiki knowledge base. Answer questions based on the provided wiki pages. Use citations like [1], [2] to reference specific pages. If the answer isn't in the wiki, say so clearly.`,
  },
  {
    id: "academic",
    name: "Academic Research",
    description: "Rigorous academic style with precise citations",
    systemPrompt: `You are an academic research assistant. When answering questions, maintain scholarly rigor: cite sources precisely using [N] notation, distinguish between established facts and hypotheses, and note methodological considerations. If evidence is conflicting, present all sides. Use formal academic language.`,
  },
  {
    id: "concise",
    name: "Concise",
    description: "Brief, direct answers",
    systemPrompt: `Answer concisely. Provide direct answers with essential information only. Use bullet points for lists. Include citations [N] but keep explanations minimal. If the user needs more detail, they will ask.`,
  },
  {
    id: "creative",
    name: "Creative Explorer",
    description: "Exploratory and creative analysis",
    systemPrompt: `You are a creative knowledge explorer. When analyzing the wiki, look for unexpected connections, propose novel hypotheses, and suggest areas for further investigation. Feel free to synthesize ideas across different wiki pages. Use citations [N] but also share your own analytical insights.`,
  },
]

export function getTemplate(id: string): PromptTemplate | undefined {
  return BUILTIN_TEMPLATES.find(t => t.id === id)
}

export function resolveSystemPrompt(
  activeTemplateId: string | null,
  customTemplates: Record<string, string>,
  fallbackPrompt: string,
): string {
  if (!activeTemplateId) return fallbackPrompt
  // Check custom templates first
  if (customTemplates[activeTemplateId]) return customTemplates[activeTemplateId]
  // Check built-in templates
  const builtin = getTemplate(activeTemplateId)
  return builtin?.systemPrompt ?? fallbackPrompt
}
