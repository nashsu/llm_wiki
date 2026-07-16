import { describe, it, expect } from "vitest"
import { isGreeting } from "./greeting-detector"

describe("isGreeting — positive cases", () => {
  const GREETINGS = [
    // English
    "hi",
    "Hi",
    "HELLO",
    "hello!",
    "hey",
    "hey there",
    "hi there!",
    "yo",
    "sup",
    "howdy",
    "good morning",
    "Good Morning!",
    "good afternoon",
    "good evening",
    "good night",
    "what's up",
    "whats up",
    "wassup",
    // Chinese
    "你好",
    "你好!",
    "你好。",
    "您好",
    "嗨",
    "嗨~",
    "哈喽",
    "哈啰",
    "哈囉",
    "喂",
    "早",
    "早啊",
    "早上好",
    "中午好",
    "下午好",
    "晚上好",
    "晚安",
    "在吗",
    "在吗?",
    "在不在",
    "有人吗",
    // Japanese
    "こんにちは",
    "こんばんは",
    "おはよう",
    "やあ",
    "どうも",
    // Korean
    "안녕",
    "안녕하세요",
    // European casuals
    "hola",
    "bonjour",
    "salut",
    "hallo",
    "ciao",
    // Whitespace tolerance
    "  hello  ",
    "  你好  ",
  ]

  for (const text of GREETINGS) {
    it(`treats ${JSON.stringify(text)} as a greeting`, () => {
      expect(isGreeting(text)).toBe(true)
    })
  }
})

describe("isGreeting — negative cases", () => {
  const NON_GREETINGS = [
    // Empty / whitespace
    "",
    "   ",
    // Greeting followed by a real question (integrated queries)
    "hello, how do I train a transformer?",
    "你好,请问怎么写 LangGraph 的 node?",
    "hi, could you summarize the page on attention mechanisms",
    "嗨,帮我查一下向量检索的那几篇",
    // Substantive questions
    "what is attention",
    "解释一下 MoE",
    "summarize the purpose page",
    // Single word that contains a greeting substring but isn't one
    "hibernation",
    "hello world program",
    "heyday",
    // Long message that happens to start with a greeting
    "hi everyone I wanted to ask about the new retrieval pipeline design",
    // Generic affirmation / farewell (not greeting)
    "ok",
    "thanks",
    "bye",
    "再见",
  ]

  for (const text of NON_GREETINGS) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(isGreeting(text)).toBe(false)
    })
  }
})
