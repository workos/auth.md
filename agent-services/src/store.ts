import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { config } from "./config.js";

export type User = {
  id: string;
  email: string;
  email_verified: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  name?: string;
};

export type Credential = {
  token: string;
  user_id?: string;
  scope: string[];
  issued_at: Date;
  expires_at?: Date;
  revoked: boolean;
  source: "identity_assertion" | "anonymous" | "service_auth";
  iss?: string;
  sub?: string;
  aud?: string;
  registration_id?: string;
};

export type Delegation = {
  iss: string;
  sub: string;
  user_id: string;
  first_seen: Date;
  last_seen: Date;
};

export type RegistrationKind = "anonymous" | "service_auth" | "id_jag";

/**
 * The user-facing leg of the claim ceremony. Tracks the `claim_attempt_token`
 * that binds the verification URL to this registration and the `user_code`
 * the agent surfaces to the user. Naming follows RFC 8628 device
 * authorization.
 */
/**
 * The identifier the agent hinted at — used to surface a mismatch advisory
 * if the signed-in user doesn't match. The wire stays a CIBA-shaped opaque
 * string; routes call `classifyLoginHint` at the edge to tag it. Structured
 * so adding `kind: "phone"` etc. only touches the classifier.
 */
export type LoginHint = { kind: "email"; value: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function classifyLoginHint(s: string): LoginHint | undefined {
  const value = s.trim();
  if (EMAIL_SHAPE.test(value)) return { kind: "email", value };
  return undefined;
}

export type RegistrationClaimAttempt = {
  id: string;
  /** Hash of the claim_attempt_token embedded in the verification URL. */
  view_token_hash: string;
  view_expires_at: Date;
  /** Hash of the 6-digit user_code the agent surfaces to the user. */
  user_code_hash: string;
  user_code_generated_at: Date;
  user_code_expires_at: Date;
  /**
   * The hint the agent supplied when minting this attempt. Per-attempt so a
   * re-mint can carry a corrected hint without affecting prior attempts.
   */
  login_hint?: LoginHint;
};

/**
 * The agent-facing leg of the claim ceremony. The agent holds the claim
 * token; the user-facing attempt holds the view token, the user_code, and
 * the agent's hint. For anonymous registrations the attempt isn't populated
 * until the agent initiates claim via /agent/identity/claim.
 */
export type RegistrationClaim = {
  token_hash: string;
  expires_at: Date;
  attempt?: RegistrationClaimAttempt;
};

/**
 * The (iss, sub, aud) of the original provider ID-JAG. Present on id_jag
 * registrations so that future credential lifecycle (revocation, audit,
 * /token refresh) has a durable identity to anchor to.
 */
export type RegistrationIdJag = {
  iss: string;
  sub: string;
  aud: string;
};

export class Registration {
  id: string;
  kind: RegistrationKind;
  user_id?: string;
  created_at: Date;
  claimed_at?: Date;
  revoked_at?: Date;
  claim?: RegistrationClaim;
  id_jag?: RegistrationIdJag;

  constructor(init: {
    id: string;
    kind: RegistrationKind;
    created_at: Date;
    user_id?: string;
    claimed_at?: Date;
    revoked_at?: Date;
    claim?: RegistrationClaim;
    id_jag?: RegistrationIdJag;
  }) {
    this.id = init.id;
    this.kind = init.kind;
    this.user_id = init.user_id;
    this.created_at = init.created_at;
    this.claimed_at = init.claimed_at;
    this.revoked_at = init.revoked_at;
    this.claim = init.claim;
    this.id_jag = init.id_jag;
  }

  /**
   * Derived from the registration's other fields — no separate `status`
   * column to keep in sync, no sweeper job needed to mark things expired.
   */
  get status(): "unclaimed" | "pending_claim" | "claimed" | "expired" {
    /*
     * A provider-pushed revocation (SET) severs the delegation this
     * registration anchors. Check it before `claimed_at` so a claimed
     * registration can't keep re-minting credentials after revocation.
     */
    if (this.revoked_at) return "expired";
    if (this.claimed_at) return "claimed";
    if (this.claim && this.claim.expires_at.getTime() < Date.now()) {
      return "expired";
    }
    if (this.claim?.attempt) return "pending_claim";
    return "unclaimed";
  }
}

/**
 * Cookie-bound user sessions for the service-owned /claim form are
 * managed by express-session (configured in index.ts); no Map needed here.
 */

export const users = new Map<string, User>();
export const credentials = new Map<string, Credential>();
export const delegations = new Map<string, Delegation>();
export const registrations = new Map<string, Registration>();
export const seenJtis = new Map<string, number>();

const seeded: User[] = [
  {
    id: "user_alice",
    email: "alice@service.example.com",
    email_verified: true,
    name: "Alice",
  },
  {
    id: "user_bob",
    email: "bob@service.example.com",
    email_verified: true,
    name: "Bob",
  },
];
for (const u of seeded) users.set(u.id, u);

export function findUserByEmail(email: string): User | undefined {
  const needle = email.toLowerCase();
  for (const u of users.values()) {
    if (u.email_verified && u.email.toLowerCase() === needle) return u;
  }
  return undefined;
}

export function findUserByPhone(phone: string): User | undefined {
  for (const u of users.values()) {
    if (u.phone_number_verified && u.phone_number === phone) return u;
  }
  return undefined;
}

export function createUser(input: Omit<User, "id">): User {
  const user: User = { ...input, id: `user_${randomUUID()}` };
  users.set(user.id, user);
  return user;
}

export function delegationKey(iss: string, sub: string): string {
  return `${iss} ${sub}`;
}

export function findDelegation(
  iss: string,
  sub: string,
): Delegation | undefined {
  return delegations.get(delegationKey(iss, sub));
}

export function upsertDelegation(
  iss: string,
  sub: string,
  userId: string,
): Delegation {
  const key = delegationKey(iss, sub);
  const now = new Date();
  const existing = delegations.get(key);
  if (existing) {
    existing.last_seen = now;
    return existing;
  }
  const d: Delegation = {
    iss,
    sub,
    user_id: userId,
    first_seen: now,
    last_seen: now,
  };
  delegations.set(key, d);
  return d;
}

function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function issueAccessToken(input: {
  /** Optional: anonymous registrations (pre-claim) have no bound user yet. */
  userId?: string;
  scope: string[];
  source: "identity_assertion" | "service_auth" | "anonymous";
  iss?: string;
  sub?: string;
  aud?: string;
  registrationId?: string;
}): Credential {
  const now = new Date();
  const token = randomToken("at_");
  const cred: Credential = {
    token,
    user_id: input.userId,
    scope: input.scope,
    issued_at: now,
    expires_at: new Date(now.getTime() + config.accessTokenTtlSeconds * 1000),
    revoked: false,
    source: input.source,
    iss: input.iss,
    sub: input.sub,
    aud: input.aud,
    registration_id: input.registrationId,
  };
  credentials.set(token, cred);
  return cred;
}

export function findCredential(token: string): Credential | undefined {
  const c = credentials.get(token);
  if (!c) return undefined;
  if (c.revoked) return undefined;
  if (c.expires_at && c.expires_at.getTime() < Date.now()) return undefined;
  return c;
}

/**
 * Provider-pushed revocation (RFC 8935 SET). Severs everything anchored to
 * the `(iss, sub, aud)` delegation, not just the currently-outstanding
 * access tokens: it revokes the credential rows, tears down the registration
 * (marking it revoked and dropping its claim handle so neither the claim
 * grant nor the jwt-bearer grant can re-mint), and deletes the delegation
 * record. This upholds the documented contract in `AUTH.md` — the identity
 * assertion, the registration, and every derived access token are all
 * invalidated.
 */
export function revokeForDelegation(
  iss: string,
  sub: string,
  aud: string,
): { credentials: number; registrations: number } {
  let credentialCount = 0;
  for (const c of credentials.values()) {
    if (!c.revoked && c.iss === iss && c.sub === sub && c.aud === aud) {
      c.revoked = true;
      credentialCount += 1;
    }
  }

  const now = new Date();
  let registrationCount = 0;
  for (const r of registrations.values()) {
    if (
      r.id_jag &&
      r.id_jag.iss === iss &&
      r.id_jag.sub === sub &&
      r.id_jag.aud === aud &&
      !r.revoked_at
    ) {
      r.revoked_at = now;
      /* Drop the claim handle so the surviving claim_token stops resolving. */
      r.claim = undefined;
      registrationCount += 1;
    }
  }

  delegations.delete(delegationKey(iss, sub));

  return { credentials: credentialCount, registrations: registrationCount };
}

export function revokeCredential(token: string): boolean {
  const c = credentials.get(token);
  if (!c || c.revoked) return false;
  c.revoked = true;
  return true;
}

export function recordJti(jti: string, expSeconds: number): "ok" | "replay" {
  sweepJtis();
  if (seenJtis.has(jti)) return "replay";
  seenJtis.set(jti, expSeconds + config.clockSkewSeconds);
  return "ok";
}

function sweepJtis(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of seenJtis) {
    if (exp < nowSec) seenJtis.delete(jti);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Anonymous registrations start with an empty claim (only the agent's claim
 * token is set — no email, no attempt). The agent receives the claim token
 * in the registration response and can later initiate the user-facing
 * ceremony by calling /agent/identity/claim with an email address.
 */
export function createAnonymousRegistration(): {
  registration: Registration;
  claimTokenPlaintext: string;
} {
  const now = new Date();
  const registrationId = `reg_${randomBytes(16).toString("base64url")}`;
  const claimTokenPlaintext = `clm_${randomBytes(19).toString("base64url")}`;

  const registration = new Registration({
    id: registrationId,
    kind: "anonymous",
    created_at: now,
    claim: {
      token_hash: sha256Hex(claimTokenPlaintext),
      expires_at: new Date(now.getTime() + config.anonymousTtlSeconds * 1000),
    },
  });
  registrations.set(registration.id, registration);
  return { registration, claimTokenPlaintext };
}

/**
 * service_auth registrations bundle the claim ceremony: the agent
 * receives a `user_code` and `verification_uri` in the registration response
 * and surfaces both to the user. The user signs in to the service, types the
 * code on the claim page, and ownership transfers.
 */
export function createServiceAuthRegistration(input: {
  login_hint: LoginHint;
}): {
  registration: Registration;
  claimTokenPlaintext: string;
  claimViewTokenPlaintext: string;
  userCode: string;
  userCodeExpiresAt: Date;
} {
  const now = new Date();
  const registrationId = `reg_${randomBytes(16).toString("base64url")}`;
  const claimTokenPlaintext = `clm_${randomBytes(19).toString("base64url")}`;
  const claimViewTokenPlaintext = `cvt_${randomBytes(24).toString("base64url")}`;
  const code = mintUserCode(now);

  const registration = new Registration({
    id: registrationId,
    kind: "service_auth",
    created_at: now,
    claim: {
      token_hash: sha256Hex(claimTokenPlaintext),
      expires_at: new Date(now.getTime() + config.anonymousTtlSeconds * 1000),
      attempt: {
        id: `cla_${randomBytes(16).toString("base64url")}`,
        view_token_hash: sha256Hex(claimViewTokenPlaintext),
        view_expires_at: new Date(
          now.getTime() + config.claimViewTokenTtlSeconds * 1000,
        ),
        user_code_hash: code.hash,
        user_code_generated_at: now,
        user_code_expires_at: code.expiresAt,
        login_hint: input.login_hint,
      },
    },
  });
  registrations.set(registration.id, registration);
  return {
    registration,
    claimTokenPlaintext,
    claimViewTokenPlaintext,
    userCode: code.plaintext,
    userCodeExpiresAt: code.expiresAt,
  };
}

function idJagRegistrationKey(iss: string, sub: string, aud: string): string {
  return `reg_${sha256Hex(`${iss}|${sub}|${aud}`).slice(0, 22)}`;
}

/**
 * Resolve an ID-JAG against the registration store. Always keyed on the
 * (iss, sub, aud) triple — the same triple maps to the same registration
 * row whether or not the user has confirmed yet.
 *
 * Context discriminates the two paths the matcher arrives via:
 *  - `{ user }` — the matcher resolved the ID-JAG to a known user (existing
 *    delegation or JIT-provisioned). No ceremony; mark claimed.
 *  - `{ email }` — the matcher found an account matching the ID-JAG's
 *    verified email/phone but no delegation yet. The user must confirm via
 *    the same user_code ceremony service_auth uses. Returns the
 *    ceremony plaintexts so the route can surface them to the agent.
 *
 * On step-up retry (second presentation while a ceremony is in flight),
 * the existing pending registration is re-issued with a fresh ceremony —
 * old claim_attempt_token + user_code stop working. Mirrors anonymous
 * /agent/identity/claim's same-email retry behavior.
 */
export type IdJagContext = { user: User } | { email: string };

export type FindOrCreateIdJagResult =
  | { kind: "ready"; registration: Registration }
  | {
      kind: "step_up";
      registration: Registration;
      claimTokenPlaintext: string;
      claimViewTokenPlaintext: string;
      userCode: string;
      userCodeExpiresAt: Date;
    };

export function findOrCreateIdJagRegistration(input: {
  iss: string;
  sub: string;
  aud: string;
  context: IdJagContext;
}): FindOrCreateIdJagResult {
  const id = idJagRegistrationKey(input.iss, input.sub, input.aud);
  const existing = registrations.get(id);
  const now = new Date();

  if ("user" in input.context) {
    /* Clean match — known user. Create or refresh the binding. */
    if (existing) {
      existing.user_id = input.context.user.id;
      if (!existing.claimed_at) existing.claimed_at = now;
      /*
       * A prior provider SET may have revoked this binding. Reaching a
       * clean match again means the delegation was legitimately
       * re-established — matchOrProvision only returns a `user` context
       * from a live delegation or JIT-provisioning, and getting here at
       * all requires a fresh, non-replayable ID-JAG (verifyIdJag enforces
       * jti-replay and auth_time freshness). Revive the registration so it
       * isn't left in a revoked-but-"ready" limbo where the identity
       * endpoint would sign an assertion for an "expired" registration.
       */
      existing.revoked_at = undefined;
      return { kind: "ready", registration: existing };
    }
    const registration = new Registration({
      id,
      kind: "id_jag",
      user_id: input.context.user.id,
      created_at: now,
      claimed_at: now,
      id_jag: { iss: input.iss, sub: input.sub, aud: input.aud },
    });
    registrations.set(registration.id, registration);
    return { kind: "ready", registration };
  }

  /* Step-up — user must confirm via ceremony. */
  if (existing && existing.status === "claimed") {
    /*
     * Race: someone completed the ceremony between the matcher running
     * and us getting here, or a prior step-up landed before this one.
     * Either way, it's a clean match now.
     */
    return { kind: "ready", registration: existing };
  }

  const claimTokenPlaintext = `clm_${randomBytes(19).toString("base64url")}`;
  const claimViewTokenPlaintext = `cvt_${randomBytes(24).toString("base64url")}`;
  const code = mintUserCode(now);
  const claim = {
    token_hash: sha256Hex(claimTokenPlaintext),
    expires_at: new Date(now.getTime() + config.anonymousTtlSeconds * 1000),
    attempt: {
      id: `cla_${randomBytes(16).toString("base64url")}`,
      view_token_hash: sha256Hex(claimViewTokenPlaintext),
      view_expires_at: new Date(
        now.getTime() + config.claimViewTokenTtlSeconds * 1000,
      ),
      user_code_hash: code.hash,
      user_code_generated_at: now,
      user_code_expires_at: code.expiresAt,
      login_hint: { kind: "email" as const, value: input.context.email },
    },
  };

  if (existing) {
    /*
     * Pending step-up exists — re-issue ceremony. Prior URL/code stop
     * working; the agent surfaces the new ones to the user.
     */
    if (existing.revoked_at) {
      /*
       * The binding was revoked by a provider SET, but a fresh,
       * non-replayed ID-JAG (verifyIdJag enforces jti-replay and
       * auth_time freshness) plus this confirmation ceremony is a
       * legitimate re-authorization. Clear the revocation and the stale
       * claimed_at so the registration drops back to a pending_claim
       * state — it only becomes "claimed" again once the user completes
       * the new ceremony, so no credential is issued before then.
       */
      existing.revoked_at = undefined;
      existing.claimed_at = undefined;
    }
    existing.claim = claim;
    return {
      kind: "step_up",
      registration: existing,
      claimTokenPlaintext,
      claimViewTokenPlaintext,
      userCode: code.plaintext,
      userCodeExpiresAt: code.expiresAt,
    };
  }

  const registration = new Registration({
    id,
    kind: "id_jag",
    created_at: now,
    claim,
    id_jag: { iss: input.iss, sub: input.sub, aud: input.aud },
  });
  registrations.set(registration.id, registration);
  return {
    kind: "step_up",
    registration,
    claimTokenPlaintext,
    claimViewTokenPlaintext,
    userCode: code.plaintext,
    userCodeExpiresAt: code.expiresAt,
  };
}

export function findRegistrationById(id: string): Registration | undefined {
  return registrations.get(id);
}

export function findRegistrationByClaimHash(
  hash: string,
): Registration | undefined {
  for (const r of registrations.values()) {
    if (r.claim?.token_hash === hash) return r;
  }
  return undefined;
}

export function findRegistrationByClaimViewHash(
  hash: string,
): Registration | undefined {
  for (const r of registrations.values()) {
    if (r.claim?.attempt?.view_token_hash === hash) return r;
  }
  return undefined;
}

export function recordClaimAttempt(
  registration: Registration,
  login_hint: LoginHint,
): {
  claimViewTokenPlaintext: string;
  userCode: string;
  userCodeExpiresAt: Date;
} {
  if (!registration.claim) {
    throw new Error("registration has no claim handle");
  }
  const now = new Date();
  const plaintext = `cvt_${randomBytes(24).toString("base64url")}`;
  const code = mintUserCode(now);
  registration.claim.attempt = {
    id: `cla_${randomBytes(16).toString("base64url")}`,
    view_token_hash: sha256Hex(plaintext),
    view_expires_at: new Date(
      now.getTime() + config.claimViewTokenTtlSeconds * 1000,
    ),
    user_code_hash: code.hash,
    user_code_generated_at: now,
    user_code_expires_at: code.expiresAt,
    login_hint,
  };
  return {
    claimViewTokenPlaintext: plaintext,
    userCode: code.plaintext,
    userCodeExpiresAt: code.expiresAt,
  };
}

/**
 * Mints a 6-digit user_code with its hash + expiry. Caller embeds the hash
 * on the attempt; the plaintext is returned to the agent (and read by the
 * user from the agent's UI).
 */
function mintUserCode(now: Date): {
  plaintext: string;
  hash: string;
  expiresAt: Date;
} {
  const plaintext = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return {
    plaintext,
    hash: sha256Hex(plaintext),
    expiresAt: new Date(now.getTime() + config.userCodeTtlSeconds * 1000),
  };
}

export type CompleteClaimResult =
  | { ok: true; registration: Registration; user: User }
  | {
      ok: false;
      error:
        | "user_code_invalid"
        | "user_code_expired"
        | "previously_claimed"
        | "claim_expired";
    };

/**
 * Called by the user-facing `/claim` form handler after authenticating the
 * user via the session cookie. The agent never reaches this code path —
 * it polls `/oauth2/token` with the claim grant for the resulting status.
 */
export function completeClaim(
  registration: Registration,
  userCode: string,
  signedInUser: User,
): CompleteClaimResult {
  if (registration.status === "claimed") {
    return { ok: false, error: "previously_claimed" };
  }
  if (registration.status === "expired") {
    return { ok: false, error: "claim_expired" };
  }
  const attempt = registration.claim?.attempt;
  if (!attempt) {
    return { ok: false, error: "claim_expired" };
  }
  if (attempt.user_code_expires_at.getTime() < Date.now()) {
    return { ok: false, error: "user_code_expired" };
  }
  if (sha256Hex(userCode) !== attempt.user_code_hash) {
    return { ok: false, error: "user_code_invalid" };
  }

  registration.user_id = signedInUser.id;
  registration.claimed_at = new Date();
  /*
   * Keep the claim handle around so the agent's poll can resolve the
   * registration by claim_token after completion. `status === "claimed"`
   * already prevents re-completion.
   */

  if (registration.kind === "anonymous") {
    /*
     * Revoke any pre-claim access_tokens. The agent's claim-grant poll on
     * /oauth2/token will return a fresh post-claim access_token + v2
     * identity_assertion; the pre-claim credentials are no longer the
     * canonical handle.
     */
    for (const cred of credentials.values()) {
      if (cred.registration_id === registration.id && !cred.revoked) {
        cred.revoked = true;
      }
    }
  }

  if (registration.kind === "id_jag" && registration.id_jag) {
    /*
     * Step-up complete: bind the (iss, sub) → user delegation so future
     * ID-JAGs from this provider for this sub take the clean-match path.
     */
    upsertDelegation(
      registration.id_jag.iss,
      registration.id_jag.sub,
      signedInUser.id,
    );
  }

  return { ok: true, registration, user: signedInUser };
}
