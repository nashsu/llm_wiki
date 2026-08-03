import { z } from "zod"
import { DynamicValue } from "./common.js"

export const SettingKeyParamSchema = z.object({
  key: z.string().min(1).max(200),
})

export const SettingWriteBodySchema = z.object({
  value: DynamicValue,
})

export const SettingWriteManyBodySchema = z.object({
  values: z.record(z.string(), DynamicValue),
})

export type SettingKeyParam = z.infer<typeof SettingKeyParamSchema>
export type SettingWriteBody = z.infer<typeof SettingWriteBodySchema>
export type SettingWriteManyBody = z.infer<typeof SettingWriteManyBodySchema>
