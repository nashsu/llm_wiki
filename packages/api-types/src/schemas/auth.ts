import { z } from "zod"

export const LoginRequestSchema = z.object({
  token: z.string().min(1, "Token is required"),
})

export const LoginResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
})

export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type LoginResponse = z.infer<typeof LoginResponseSchema>
