import { z } from "zod"

export const SettingKeyParamSchema = z.object({
  key: z.string().min(1).max(200),
})

export const SettingWriteBodySchema = z.object({
  value: z.unknown(),
})

export const SettingWriteManyBodySchema = z.object({
  values: z.record(z.string(), z.unknown()),
})
