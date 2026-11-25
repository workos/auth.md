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

/**
 * Exchanges a rotating refresh token (issued to service_auth and claimed
 * registrations at claim/complete) for a fresh identity assertion. Anonymous
 * pre-claim and id_jag registrations have no refresh token — they re-exchange
 * the assertion or re-register instead.
 */
const refreshBody = z.object({
  type: z.literal("refresh"),
  refresh_token: z.string().min(1),
});

export const agentAuthBody = z.union([
  idJagAssertionBody,
  serviceAuthBody,
  anonymousBody,
  refreshBody,
]);

/**
 * Starts (or re-mints) a claim attempt. `type` is the claim method, not the
 * registration kind — anonymous registrations are claimed via `service_auth`
 * too. The `login_hint` binds the attempt to the human who may complete it.
 */
export const claimBody = z.object({
  type: z.literal("service_auth"),
  claim_token: z.string().min(1),
  login_hint: z.email(),
});

/**
 * Agent-facing claim completion. The agent presents its claim token plus the
 * user_code the confirming human read off the claim page and relayed back.
 */
export const claimCompleteBody = z.object({
  claim_token: z.string().min(1),
  user_code: z.string().regex(/^\d{6}$/, "user_code must be a 6-digit code"),
});

/** Mock IdP sign-in form. */
export const loginFormBody = z.object({
  email: z.email(),
  return_to: z.string().optional(),
});

/**
 * User-facing claim confirmation form. The signed-in human confirms; the page
 * then reveals the user_code for them to read back to the agent. No code is
 * typed here — it travels service → user → agent, not the other way.
 */
export const claimConfirmFormBody = z.object({
  claim_attempt_token: z.string().min(1),
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
