import { z } from "zod";

const ID_JAG = "urn:ietf:params:oauth:token-type:id-jag";
const EMAIL_ASSERTION = "verified_email";

const idJagAssertionBody = z.object({
  type: z.literal("identity_assertion"),
  assertion_type: z.literal(ID_JAG),
  assertion: z.string().min(1),
});

const emailAssertionBody = z.object({
  type: z.literal("identity_assertion"),
  assertion_type: z.literal(EMAIL_ASSERTION),
  assertion: z.email(),
});

const anonymousBody = z.object({
  type: z.literal("anonymous"),
});

export const agentAuthBody = z.union([
  idJagAssertionBody,
  emailAssertionBody,
  anonymousBody,
]);

export const claimBody = z.object({
  claim_token: z.string().min(1),
  email: z.email(),
});

export const claimCompleteBody = z.object({
  claim_token: z.string().min(1),
  otp: z.string().min(1),
});

// RFC 7523 JWT-bearer grant at /oauth2/token. `assertion` is the parameter
// name RFC 7523 §2.1 mandates; the value is the JWT the agent received as
// `identity.assertion` from /agent/register.
export const tokenEndpointBody = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:jwt-bearer"),
  assertion: z.string().min(1),
  resource: z.string().optional(),
  scope: z.string().optional(),
});

// RFC 7009 token revocation. token_type_hint is optional; the spec says the
// server MAY use it as a hint but isn't required to honor it.
export const revocationEndpointBody = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().optional(),
});

export const generateOtpBody = z.object({
  claim_attempt_token: z.string().min(1),
});

export const ASSERTION_TYPES = { ID_JAG, EMAIL_ASSERTION } as const;

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
