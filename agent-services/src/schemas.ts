import { z } from "zod";

const ID_JAG = "urn:ietf:params:oauth:token-type:id-jag";

const idJagAssertionBody = z.object({
  type: z.literal("identity_assertion"),
  assertion_type: z.literal(ID_JAG),
  assertion: z.string().min(1),
});

const serviceAuthBody = z.object({
  type: z.literal("service_auth"),
  login_hint: z.string().min(1),
});

const anonymousBody = z.object({
  type: z.literal("anonymous"),
});

export const agentAuthBody = z.union([
  idJagAssertionBody,
  serviceAuthBody,
  anonymousBody,
]);

/* POST /agent/identity/claim — discriminated on `type`. */
const loginHintClaimBody = z.object({
  type: z.literal("login_hint"),
  claim_token: z.string().min(1),
  login_hint: z.string().min(1),
});

const idJagClaimBody = z.object({
  type: z.literal("identity_assertion"),
  claim_token: z.string().min(1),
  assertion: z.string().min(1),
});

export const claimBody = z.discriminatedUnion("type", [
  loginHintClaimBody,
  idJagClaimBody,
]);

/** Mock IdP sign-in form. */
export const loginFormBody = z.object({
  email: z.email(),
  return_to: z.string().optional(),
});

/** User-facing claim form. */
export const claimFormBody = z.object({
  claim_attempt_token: z.string().min(1),
  user_code: z.string().regex(/^\d{6}$/, "user_code must be a 6-digit code"),
});

/**
 * RFC 7523 JWT-bearer grant body for `/oauth2/token`. The agent presents a
 * service-signed identity_assertion as the `assertion` parameter; the
 * service exchanges it for an access_token scoped per the registration's
 * state.
 */
export const jwtBearerGrantBody = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:jwt-bearer"),
  assertion: z.string().min(1),
  resource: z.string().url().optional(),
});

/**
 * Profile-specific grant for claim-ceremony polling. Device-authorization-
 * shaped (RFC 8628 §3.4 semantics) but uses our own grant URN so it doesn't
 * collide with services that also implement standard device auth. The
 * `claim_token` from the registration response is the polling bearer.
 */
export const claimGrantBody = z.object({
  grant_type: z.literal("urn:workos:agent-auth:grant-type:claim"),
  claim_token: z.string().min(1),
});

/** RFC 7009 token revocation. */
export const revocationEndpointBody = z.object({
  token: z.string().min(1),
  token_type_hint: z.literal("access_token").optional(),
});

export const ASSERTION_TYPES = { ID_JAG } as const;

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
