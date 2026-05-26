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
  source: "identity_assertion" | "anonymous" | "email_verification";
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

export type RegistrationKind = "anonymous" | "email_verification" | "id_jag";

// The user-facing leg of the claim ceremony. Tracks the OTP-view link sent
// to the user and (once /attempt/challenge fires) the OTP that link reveals.
export type RegistrationClaimAttempt = {
  id: string;
  view_token_hash: string;
  view_expires_at: Date;
  otp?: {
    hash: string;
    generated_at: Date;
    expires_at: Date;
  };
};

// The agent-facing leg of the claim ceremony. The agent holds the claim
// token; the email recipient holds the view token (inside the attempt). For
// anonymous registrations the email/attempt aren't populated until the agent
// initiates claim via /agent/register/claim.
export type RegistrationClaim = {
  token_hash: string;
  email?: string;
  expires_at: Date;
  attempt?: RegistrationClaimAttempt;
};

// The (iss, sub, aud) of the original provider ID-JAG. Present on id_jag
// registrations so that on a successful claim (or for a clean match) we can
// create the delegation that anchors future credentials to this provider.
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
  claim?: RegistrationClaim;
  id_jag?: RegistrationIdJag;

  constructor(init: {
    id: string;
    kind: RegistrationKind;
    created_at: Date;
    user_id?: string;
    claimed_at?: Date;
    claim?: RegistrationClaim;
    id_jag?: RegistrationIdJag;
  }) {
    this.id = init.id;
    this.kind = init.kind;
    this.user_id = init.user_id;
    this.created_at = init.created_at;
    this.claimed_at = init.claimed_at;
    this.claim = init.claim;
    this.id_jag = init.id_jag;
  }

  // Derived from the registration's other fields — no separate `status`
  // column to keep in sync, no sweeper job needed to mark things expired.
  get status(): "unclaimed" | "pending_claim" | "claimed" | "expired" {
    if (this.claimed_at) return "claimed";
    if (this.claim && this.claim.expires_at.getTime() < Date.now()) {
      return "expired";
    }
    if (this.claim?.attempt) return "pending_claim";
    return "unclaimed";
  }
}

export const users = new Map<string, User>();
export const credentials = new Map<string, Credential>();
export const delegations = new Map<string, Delegation>();
export const registrations = new Map<string, Registration>();
export const seenJtis = new Map<string, number>();

const seeded: User[] = [
  {
    id: "user_alice",
    email: "alice@example.com",
    email_verified: true,
    name: "Alice",
  },
  {
    id: "user_bob",
    email: "bob@example.com",
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
  // Optional: anonymous registrations (pre-claim) have no bound user yet.
  userId?: string;
  scope: string[];
  source: "identity_assertion" | "email_verification" | "anonymous";
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

export function revokeForDelegation(
  iss: string,
  sub: string,
  aud: string,
): number {
  let count = 0;
  for (const c of credentials.values()) {
    if (!c.revoked && c.iss === iss && c.sub === sub && c.aud === aud) {
      c.revoked = true;
      count += 1;
    }
  }
  return count;
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

// Anonymous registrations start with an empty claim (only the agent's claim
// token is set — no email, no attempt). The agent receives the claim token
// in the registration response and can later initiate the user-facing
// ceremony by calling /agent/register/claim with an email address.
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

// Email-verification registrations bundle the claim attempt: the ceremony
// is initiated synchronously with registration creation, so the agent can
// poll /complete directly without an intermediate /claim call.
export function createEmailVerificationRegistration(input: {
  email: string;
}): {
  registration: Registration;
  claimTokenPlaintext: string;
  claimViewTokenPlaintext: string;
} {
  const now = new Date();
  const registrationId = `reg_${randomBytes(16).toString("base64url")}`;
  const claimTokenPlaintext = `clm_${randomBytes(19).toString("base64url")}`;
  const claimViewTokenPlaintext = `cvt_${randomBytes(24).toString("base64url")}`;

  const registration = new Registration({
    id: registrationId,
    kind: "email_verification",
    created_at: now,
    claim: {
      token_hash: sha256Hex(claimTokenPlaintext),
      email: input.email,
      expires_at: new Date(now.getTime() + config.anonymousTtlSeconds * 1000),
      attempt: {
        id: `cla_${randomBytes(16).toString("base64url")}`,
        view_token_hash: sha256Hex(claimViewTokenPlaintext),
        view_expires_at: new Date(
          now.getTime() + config.claimViewTokenTtlSeconds * 1000,
        ),
      },
    },
  });
  registrations.set(registration.id, registration);
  return { registration, claimTokenPlaintext, claimViewTokenPlaintext };
}

// ID-JAG step-up: the matcher found an existing account by email/phone but
// no delegation yet. Create the registration in pending_claim state so the
// user has to confirm ownership via OTP before we bind the delegation.
export function createIdJagRegistration(input: {
  iss: string;
  sub: string;
  aud: string;
  email: string;
}): {
  registration: Registration;
  claimTokenPlaintext: string;
  claimViewTokenPlaintext: string;
} {
  const now = new Date();
  const registrationId = `reg_${randomBytes(16).toString("base64url")}`;
  const claimTokenPlaintext = `clm_${randomBytes(19).toString("base64url")}`;
  const claimViewTokenPlaintext = `cvt_${randomBytes(24).toString("base64url")}`;

  const registration = new Registration({
    id: registrationId,
    kind: "id_jag",
    created_at: now,
    claim: {
      token_hash: sha256Hex(claimTokenPlaintext),
      email: input.email,
      expires_at: new Date(now.getTime() + config.anonymousTtlSeconds * 1000),
      attempt: {
        id: `cla_${randomBytes(16).toString("base64url")}`,
        view_token_hash: sha256Hex(claimViewTokenPlaintext),
        view_expires_at: new Date(
          now.getTime() + config.claimViewTokenTtlSeconds * 1000,
        ),
      },
    },
    id_jag: { iss: input.iss, sub: input.sub, aud: input.aud },
  });
  registrations.set(registration.id, registration);
  return { registration, claimTokenPlaintext, claimViewTokenPlaintext };
}

// ID-JAG clean match: the matcher found an existing delegation, or JIT-
// provisioned a fresh user. No claim ceremony required. Returns an existing
// registration for the same (iss, sub, aud) if one is already on file —
// keeps the registration_id stable across repeated ID-JAG presentations
// from the same provider/user pair.
function idJagRegistrationKey(iss: string, sub: string, aud: string): string {
  return `reg_${sha256Hex(`${iss}|${sub}|${aud}`).slice(0, 22)}`;
}

export function findOrCreateIdJagRegistration(input: {
  iss: string;
  sub: string;
  aud: string;
  userId: string;
}): Registration {
  const id = idJagRegistrationKey(input.iss, input.sub, input.aud);
  const existing = registrations.get(id);
  if (existing) {
    // Keep the user binding current in case of JIT-provision races.
    existing.user_id = input.userId;
    return existing;
  }
  const now = new Date();
  const registration = new Registration({
    id,
    kind: "id_jag",
    user_id: input.userId,
    created_at: now,
    claimed_at: now,
    id_jag: { iss: input.iss, sub: input.sub, aud: input.aud },
  });
  registrations.set(registration.id, registration);
  return registration;
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

// Initiates (or rotates) the user-facing leg of an anonymous registration's
// claim ceremony. The agent must already hold the claim token from
// registration; here it supplies the email recipient.
export function recordAnonymousClaimAttempt(
  registration: Registration,
  email: string,
): string {
  if (!registration.claim) {
    throw new Error(
      "anonymous registration missing claim block; cannot record attempt",
    );
  }
  const now = new Date();
  const plaintext = `cvt_${randomBytes(24).toString("base64url")}`;
  registration.claim.email = email;
  registration.claim.attempt = {
    id: `cla_${randomBytes(16).toString("base64url")}`,
    view_token_hash: sha256Hex(plaintext),
    view_expires_at: new Date(
      now.getTime() + config.claimViewTokenTtlSeconds * 1000,
    ),
  };
  return plaintext;
}

// Mints a fresh OTP and overwrites any prior one on the same attempt.
// Refreshing the claim-view page reissues a code; the previous code is no
// longer accepted.
export function generateOtpForRegistration(registration: Registration): {
  otp: string;
  expiresAt: Date;
} {
  const attempt = registration.claim?.attempt;
  if (!attempt) {
    throw new Error(
      "registration has no claim attempt in flight; cannot generate OTP",
    );
  }
  const now = new Date();
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + config.otpTtlSeconds * 1000);
  attempt.otp = {
    hash: sha256Hex(otp),
    generated_at: now,
    expires_at: expiresAt,
  };
  return { otp, expiresAt };
}

export type CompleteClaimResult =
  | { ok: true; registration: Registration }
  | {
      ok: false;
      error:
        | "otp_invalid"
        | "otp_expired"
        | "otp_not_generated"
        | "previously_claimed"
        | "claim_expired";
    };

export function completeClaim(
  registration: Registration,
  otp: string,
): CompleteClaimResult {
  if (registration.status === "claimed") {
    return { ok: false, error: "previously_claimed" };
  }
  if (registration.status === "expired") {
    return { ok: false, error: "claim_expired" };
  }
  const attempt = registration.claim?.attempt;
  if (!attempt?.otp) {
    return { ok: false, error: "otp_not_generated" };
  }
  if (attempt.otp.expires_at.getTime() < Date.now()) {
    return { ok: false, error: "otp_expired" };
  }
  if (sha256Hex(otp) !== attempt.otp.hash) {
    return { ok: false, error: "otp_invalid" };
  }

  switch (registration.kind) {
    case "anonymous":
      return completeAnonymousClaim(registration);
    case "email_verification":
      return completeEmailVerificationClaim(registration);
    case "id_jag":
      return completeIdJagClaim(registration);
  }
}

function markClaimed(registration: Registration, userId: string): void {
  registration.user_id = userId;
  registration.claimed_at = new Date();
  // Wipe the in-flight attempt: the view token and OTP shouldn't be usable
  // post-claim. The token_hash and email stay so we can still trace which
  // claim succeeded.
  if (registration.claim) registration.claim.attempt = undefined;
}

function completeAnonymousClaim(
  registration: Registration,
): CompleteClaimResult {
  const email = registration.claim?.email;
  if (!email) {
    throw new Error("anonymous claim missing email; cannot complete");
  }
  let user = findUserByEmail(email);
  if (!user) {
    user = createUser({ email, email_verified: true });
  }
  markClaimed(registration, user.id);

  // In-place scope upgrade: every unrevoked credential tied to this
  // registration gets the post-claim scope set. Lets the agent keep using
  // its existing token (with broader scope) instead of waiting for refresh.
  for (const cred of credentials.values()) {
    if (cred.registration_id === registration.id && !cred.revoked) {
      cred.user_id = user.id;
      cred.scope = config.postClaimScopes;
    }
  }
  return { ok: true, registration };
}

function completeEmailVerificationClaim(
  registration: Registration,
): CompleteClaimResult {
  const email = registration.claim?.email;
  if (!email) {
    throw new Error("email-verification claim missing email; cannot complete");
  }
  let user = findUserByEmail(email);
  if (!user) {
    user = createUser({ email, email_verified: true });
  }
  markClaimed(registration, user.id);
  return { ok: true, registration };
}

function completeIdJagClaim(registration: Registration): CompleteClaimResult {
  const email = registration.claim?.email;
  const idJag = registration.id_jag;
  if (!email || !idJag) {
    throw new Error(
      "id_jag claim missing email or id_jag block; cannot complete",
    );
  }
  const user = findUserByEmail(email);
  // The matched user existed when we issued the step-up; if they've been
  // removed since, fail closed with the already-claimed signal so we don't
  // expose the difference between "deleted" and "never matched."
  if (!user) {
    return { ok: false, error: "previously_claimed" };
  }

  upsertDelegation(idJag.iss, idJag.sub, user.id);
  markClaimed(registration, user.id);
  return { ok: true, registration };
}
