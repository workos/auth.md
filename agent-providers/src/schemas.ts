import { z } from "zod";

export const loginBody = z.object({
  email: z.email(),
});

export const createGrantBody = z.object({
  audience: z.url(),
  mode: z.enum(["once", "always"]),
  events_uri: z.url().optional(),
});

export const mintIdJagBody = z.object({
  audience: z.url(),
  resource: z.url().optional(),
  agent_platform: z.string().optional(),
  agent_context_id: z.string().optional(),
});

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; message: string } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, value: result.data };
  const message = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, message };
}
