// Comprehensive LaTeX command → Unicode mapping
const LATEX_TO_UNICODE: Record<string, string> = {
  // Arrows
  rightarrow: "→", Rightarrow: "⇒", longrightarrow: "⟶",
  leftarrow: "←", Leftarrow: "⇐", longleftarrow: "⟵",
  leftrightarrow: "↔", Leftrightarrow: "⇔",
  uparrow: "↑", Uparrow: "⇑", downarrow: "↓", Downarrow: "⇓",
  mapsto: "↦", hookrightarrow: "↪", hookleftarrow: "↩",
  nearrow: "↗", nwarrow: "↖", searrow: "↘", swarrow: "↙",
  // Math operators
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗",
  star: "⋆", circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗",
  // Relations
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", cong: "≅",
  propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻",
  subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  in: "∈", notin: "∉", ni: "∋", cap: "∩", cup: "∪",
  vee: "∨", wedge: "∧", neg: "¬", lnot: "¬",
  // Greek lowercase
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
  sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ",
  varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  // Greek uppercase
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Misc symbols
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
  emptyset: "∅", varnothing: "∅", wp: "℘", Re: "ℜ", Im: "ℑ",
  aleph: "ℵ", hbar: "ℏ", ell: "ℓ", sharp: "♯", flat: "♭",
  natural: "♮", clubsuit: "♣", diamondsuit: "♢", heartsuit: "♡", spadesuit: "♠",
  // Big operators
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", oint: "∮",
  bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂",
  // Dots
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  // Formatting
  quad: "  ", qquad: "    ", text: "", mathrm: "", mathbf: "", mathit: "",
  textbf: "", textit: "", textrm: "",
  // Delimiters
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋",
  lceil: "⌈", rceil: "⌉", lvert: "|", rvert: "|",
  // Accents
  hat: "^", tilde: "~", bar: "‾", vec: "→", dot: "·", ddot: "¨",
  // Common functions
  log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan",
  min: "min", max: "max", sup: "sup", inf: "inf", lim: "lim",
  sqrt: "√", frac: "/",
}

/**
 * Convert LaTeX notation in text to Unicode characters.
 * Handles $\command$, $expr with \commands$, and $$...$$ blocks.
 */
export function convertLatexToUnicode(text: string): string {
  let result = text

  // Handle $\command$ patterns
  result = result.replace(/\$\\([a-zA-Z]+)\$/g, (_match, cmd: string) => {
    return LATEX_TO_UNICODE[cmd] ?? `\\${cmd}`
  })

  // Handle $$...$$ display math
  result = result.replace(/\$\$([^$]+)\$\$/g, "\n$1\n")

  // Handle remaining $...$ inline math with LaTeX commands inside
  result = result.replace(/\$([^$]+)\$/g, (_match, inner: string) => {
    return inner.replace(/\\([a-zA-Z]+)/g, (_m, cmd: string) => LATEX_TO_UNICODE[cmd] ?? `\\${cmd}`)
  })

  return result
}
