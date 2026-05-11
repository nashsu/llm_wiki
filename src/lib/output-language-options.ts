/**
 * Shared list of selectable output-language values for any UI that
 * needs to ask the user what language the AI should generate in.
 *
 * `value` strings are stable internal tokens used by the output-language
 * pipeline. Labels are user-facing and intentionally localized to Chinese.
 */
export const OUTPUT_LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动（根据输入或资料源检测）" },
  { value: "English", label: "英语" },
  { value: "Chinese", label: "简体中文" },
  { value: "Traditional Chinese", label: "繁体中文" },
  { value: "Japanese", label: "日语" },
  { value: "Korean", label: "韩语" },
  { value: "Vietnamese", label: "越南语" },
  { value: "French", label: "法语" },
  { value: "German", label: "德语" },
  { value: "Spanish", label: "西班牙语" },
  { value: "Portuguese", label: "葡萄牙语" },
  { value: "Italian", label: "意大利语" },
  { value: "Russian", label: "俄语" },
  { value: "Arabic", label: "阿拉伯语" },
  { value: "Persian", label: "波斯语" },
  { value: "Hindi", label: "印地语" },
  { value: "Turkish", label: "土耳其语" },
  { value: "Dutch", label: "荷兰语" },
  { value: "Polish", label: "波兰语" },
  { value: "Swedish", label: "瑞典语" },
  { value: "Indonesian", label: "印尼语" },
  { value: "Thai", label: "泰语" },
  { value: "Ukrainian", label: "乌克兰语" },
] as const
