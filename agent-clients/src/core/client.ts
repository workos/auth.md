import { discover } from "./discovery.js";
import { FileCredentialStore, normalizeIssuer } from "./store.js";
import type { CredentialStore } from "./store.js";
import type {
  AuthenticateResult,
  ClaimAttemptResponse,
  ClaimCompleteResponse,
  IdentityType,
  IssuerRecord,
  ProtocolErrorBody,
  RegistrationResponse,
  TokenResponse,
} from "./types.js";
import { ProtocolError } from "./types.js";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_ASSERTION_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

/** Clock skew allowance when judging stored expiry timestamps. */
const EXPIRY_SLACK_MS = 30 * 1000;

export interface AuthenticateOptions {
  issuer: string;
  /**
   * The user's email (CIBA-style login_hint). Present → service_auth
   * registration (claim ceremony required). Absent → anonymous.
   */
  email?: string;
  /** RFC 8707 resource to pin the access_token to at the token endpoint. */
  resource?: string;
  /**
   * A pre-minted ID-JAG JWT from the agent's identity provider. When given,
   * registration uses identity_assertion instead of service_auth/anonymous.
   */
  idJag?: string;
  /** Force a fresh registration even if stored credentials exist. */
  forceReregister?: boolean;
}

export interface FetchOptions {
  issuer: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  resource?: string;
}

interface PendingClaim {
  registrationId: string;
  registrationType: IdentityType;
  claimToken: string;
  claimUrl: string;
  verificationUri: string;
  attemptExpiresAt: string;
  email?: string;
}

/**
 * Agent-side client for the auth.md agentic registration protocol. All
 * state is tenanted by issuer: stored credentials, cached tokens, and
 * in-flight claim ceremonies are independent per service.
 *
 * Claim tokens are held in memory only for the duration of the ceremony,
 * per AUTH.md — they are never written to the credential store.
 */
export class AgentAuthClient {
  private readonly store: CredentialStore;
  private readonly pendingClaims = new Map<string, PendingClaim>();

  constructor(store?: CredentialStore) {
    this.store = store ?? new FileCredentialStore();
  }

  /**
   * One-call authentication: reuse stored credentials when possible
   * (cached access_token → live assertion → refresh token), otherwise
   * register with the lightest applicable method. Returns ready
   * credentials, or the claim ceremony materials when a human step is
   * required.
   */
  async authenticate(opts: AuthenticateOptions): Promise<AuthenticateResult> {
    const issuer = normalizeIssuer(opts.issuer);

    // An email supplied against a live anonymous registration is an upgrade
    // request: start the claim ceremony rather than reusing anonymous access.
    if (opts.email && !opts.idJag && this.pendingClaims.has(issuer)) {
      const record = await this.store.get(issuer);
      if (record?.registration_type === "anonymous" && !record.claimed) {
        return this.startClaimAttempt(issuer, opts.email);
      }
    }

    if (!opts.forceReregister) {
      const reused = await this.tryReuse(issuer, opts.resource);
      if (reused) return reused;
    }

    return this.register(issuer, opts);
  }

  /**
   * Complete an in-flight claim ceremony with the user_code the user read
   * off the service's claim page, then exchange the post-claim assertion
   * for an access_token.
   */
  async completeClaim(
    issuer: string,
    userCode: string,
    resource?: string,
  ): Promise<AuthenticateResult> {
    const base = normalizeIssuer(issuer);
    const pending = this.pendingClaims.get(base);
    if (!pending) {
      throw new ProtocolError(
        "no_pending_claim",
        `No claim ceremony in flight for ${base}. Call authenticate first.`,
        400,
      );
    }

    const metadata = await discover(base);
    const res = await fetch(`${metadata.agent_auth.claim_endpoint}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claim_token: pending.claimToken,
        user_code: userCode,
      }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw protocolError(res.status, body);
    }
    const completed = body as ClaimCompleteResponse;
    this.pendingClaims.delete(base);

    const record: IssuerRecord = {
      registration_id: completed.id,
      registration_type: pending.registrationType,
      claimed: true,
      identity: completed.identity,
    };
    // The post-claim assertion and refresh token are one-shot: a persistence
    // failure must not prevent returning them to the caller.
    await this.persistBestEffort(base, record);
    return this.exchange(base, record, resource);
  }

  /**
   * Convenience: make an authenticated request to the service, injecting
   * the bearer token and transparently refreshing expired credentials.
   */
  async fetchWithAuth(opts: FetchOptions): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const issuer = normalizeIssuer(opts.issuer);
    const auth = await this.authenticate({ issuer, resource: opts.resource });
    if (auth.status !== "ready") {
      throw new ProtocolError(
        "claim_required",
        `A claim ceremony is required before calling the API. Hand the user: ${auth.verification_uri}`,
        401,
      );
    }
    const doFetch = (token: string) =>
      fetch(opts.url, {
        method: opts.method ?? "GET",
        headers: {
          ...opts.headers,
          Authorization: `Bearer ${token}`,
        },
        body: opts.body,
      });
    let res = await doFetch(auth.access_token);

    // A 401 against a cached token usually means it was revoked server-side:
    // drop the cache and retry once with a freshly exchanged token.
    if (res.status === 401) {
      const record = await this.store.get(issuer);
      if (record?.access_token) {
        await this.store.set(issuer, { ...record, access_token: undefined });
        const retried = await this.authenticate({
          issuer,
          resource: opts.resource,
        });
        if (retried.status === "ready") {
          res = await doFetch(retried.access_token);
        }
      }
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, body: await res.text() };
  }

  /** Attempt reuse of stored credentials, cheapest first. */
  private async tryReuse(
    issuer: string,
    resource?: string,
  ): Promise<AuthenticateResult | undefined> {
    const record = await this.store.get(issuer);
    if (!record) return undefined;

    if (
      record.access_token &&
      isLive(record.access_token.expires_at) &&
      record.access_token.resource === resource
    ) {
      return {
        status: "ready",
        access_token: record.access_token.value,
        token_type: "Bearer",
        expires_in: secondsUntil(record.access_token.expires_at),
        scope: record.access_token.scope,
        registration_id: record.registration_id,
        registration_type: record.registration_type,
        claimed: record.claimed,
      };
    }

    if (record.identity && isLive(record.identity.expires_at)) {
      return this.exchange(issuer, record, resource);
    }

    const refreshToken = record.identity?.refresh_token;
    if (refreshToken && isLive(refreshToken.expires_at)) {
      const refreshed = await this.refresh(issuer, record, refreshToken.value);
      if (refreshed) return this.exchange(issuer, refreshed, resource);
    }

    return undefined;
  }

  /** Rotate the refresh token for a fresh identity assertion. */
  private async refresh(
    issuer: string,
    record: IssuerRecord,
    refreshToken: string,
  ): Promise<IssuerRecord | undefined> {
    const metadata = await discover(issuer);
    const res = await fetch(metadata.agent_auth.identity_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "refresh", refresh_token: refreshToken }),
    });
    if (!res.ok) return undefined;
    const body = (await readJson(res)) as RegistrationResponse;
    if (!body.identity) return undefined;
    // The rotated refresh token is one-shot; don't lose it to a store failure.
    const updated: IssuerRecord = { ...record, identity: body.identity };
    await this.persistBestEffort(issuer, updated);
    return updated;
  }

  private async register(
    issuer: string,
    opts: AuthenticateOptions,
  ): Promise<AuthenticateResult> {
    const metadata = await discover(issuer);
    const supported = metadata.agent_auth.identity_types_supported;

    // A user-bound registration whose credentials have all expired must not
    // silently degrade to a fresh anonymous identity.
    if (!opts.email && !opts.idJag && !opts.forceReregister) {
      const existing = await this.store.get(issuer);
      if (existing && existing.registration_type !== "anonymous") {
        throw new ProtocolError(
          "reauthentication_required",
          `Stored ${existing.registration_type} credentials for ${issuer} have expired. Re-authenticate with the original ${existing.registration_type === "service_auth" ? "email" : "ID-JAG"}, or pass forceReregister to start over anonymously.`,
          401,
        );
      }
    }

    let requestBody: Record<string, string>;
    let registrationType: IssuerRecord["registration_type"];
    if (opts.idJag) {
      const assertionTypes =
        metadata.agent_auth.identity_assertion?.assertion_types_supported ?? [];
      if (
        !supported.includes("identity_assertion") ||
        !assertionTypes.includes(ID_JAG_ASSERTION_TYPE)
      ) {
        throw new ProtocolError(
          "unsupported_identity_type",
          `Service does not advertise identity_assertion with ${ID_JAG_ASSERTION_TYPE} (supported: [${supported.join(", ")}])`,
          400,
        );
      }
      requestBody = {
        type: "identity_assertion",
        assertion_type: ID_JAG_ASSERTION_TYPE,
        assertion: opts.idJag,
      };
      registrationType = "identity_assertion";
    } else if (opts.email && supported.includes("service_auth")) {
      requestBody = { type: "service_auth", login_hint: opts.email };
      registrationType = "service_auth";
    } else if (supported.includes("anonymous")) {
      requestBody = { type: "anonymous" };
      registrationType = "anonymous";
    } else {
      throw new ProtocolError(
        "no_applicable_method",
        `No applicable registration method: service advertises [${supported.join(", ")}]; provide an email for service_auth or an ID-JAG for identity_assertion`,
        400,
      );
    }

    const res = await fetch(metadata.agent_auth.identity_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const body = (await readJson(res)) as RegistrationResponse;

    if (res.status === 401 && body.error === "interaction_required") {
      return this.stashClaim(issuer, body, registrationType, opts.email);
    }
    if (!res.ok) {
      throw protocolError(res.status, body);
    }

    if (registrationType === "service_auth") {
      return this.stashClaim(issuer, body, registrationType, opts.email);
    }

    // anonymous and clean-match identity_assertion return an identity now
    if (!body.identity) {
      throw new ProtocolError(
        "unexpected_response",
        "Registration response carried no identity block",
        res.status,
      );
    }
    const record: IssuerRecord = {
      registration_id: body.id,
      registration_type: registrationType,
      claimed: registrationType === "identity_assertion",
      identity: body.identity,
    };
    await this.store.set(issuer, record);

    // Anonymous registrations may later be claimed; keep the claim token
    // in memory so an email-bearing follow-up can start the ceremony.
    if (registrationType === "anonymous" && body.claim) {
      this.pendingClaims.set(issuer, {
        registrationId: body.id,
        registrationType,
        claimToken: body.claim.token,
        claimUrl: body.claim.url,
        verificationUri: body.claim.attempt?.verification_uri ?? "",
        attemptExpiresAt:
          body.claim.attempt?.expires_at ?? body.claim.expires_at,
      });
    }

    return this.exchange(issuer, record, opts.resource);
  }

  /**
   * Start (or re-mint) a claim attempt for an in-flight ceremony —
   * used for anonymous upgrades and expired user_code windows.
   */
  async startClaimAttempt(
    issuer: string,
    email: string,
  ): Promise<AuthenticateResult> {
    const base = normalizeIssuer(issuer);
    const pending = this.pendingClaims.get(base);
    if (!pending) {
      throw new ProtocolError(
        "no_pending_claim",
        `No claimable registration in memory for ${base}. Re-register with authenticate.`,
        400,
      );
    }
    const res = await fetch(pending.claimUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "service_auth",
        claim_token: pending.claimToken,
        login_hint: email,
      }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw protocolError(res.status, body);
    }
    const attempt = body as ClaimAttemptResponse;
    pending.verificationUri = attempt.attempt.verification_uri;
    pending.attemptExpiresAt = attempt.attempt.expires_at;
    pending.email = email;
    return this.claimRequired(pending);
  }

  private stashClaim(
    issuer: string,
    body: RegistrationResponse,
    registrationType: IdentityType,
    email?: string,
  ): AuthenticateResult {
    if (!body.claim?.attempt) {
      throw new ProtocolError(
        "unexpected_response",
        "Claim-required registration response carried no claim.attempt block",
        200,
      );
    }
    const pending: PendingClaim = {
      registrationId: body.id,
      registrationType,
      claimToken: body.claim.token,
      claimUrl: body.claim.url,
      verificationUri: body.claim.attempt.verification_uri,
      attemptExpiresAt: body.claim.attempt.expires_at,
      email,
    };
    this.pendingClaims.set(issuer, pending);
    return this.claimRequired(pending);
  }

  private claimRequired(pending: PendingClaim): AuthenticateResult {
    return {
      status: "claim_required",
      registration_id: pending.registrationId,
      verification_uri: pending.verificationUri,
      attempt_expires_at: pending.attemptExpiresAt,
      instructions:
        "Ask the user to open the verification_uri and sign in. The page reveals a code; they read it back, and you finish with complete_claim.",
    };
  }

  /** RFC 7523 jwt-bearer exchange of the stored assertion. */
  private async exchange(
    issuer: string,
    record: IssuerRecord,
    resource?: string,
  ): Promise<AuthenticateResult> {
    if (!record.identity) {
      throw new ProtocolError(
        "no_identity",
        "No identity assertion on record to exchange",
        400,
      );
    }
    const metadata = await discover(issuer);
    const params = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: record.identity.assertion,
    });
    if (resource) params.set("resource", resource);

    const res = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw protocolError(res.status, body);
    }
    const token = body as TokenResponse;

    const updated: IssuerRecord = {
      ...record,
      access_token: {
        value: token.access_token,
        expires_at: new Date(
          Date.now() + token.expires_in * 1000,
        ).toISOString(),
        scope: token.scope,
        resource,
      },
    };
    await this.persistBestEffort(issuer, updated);

    return {
      status: "ready",
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: token.expires_in,
      scope: token.scope,
      registration_id: record.registration_id,
      registration_type: record.registration_type,
      claimed: record.claimed,
    };
  }

  /**
   * Persist without letting a storage failure destroy one-shot credentials
   * that the caller still needs returned.
   */
  private async persistBestEffort(
    issuer: string,
    record: IssuerRecord,
  ): Promise<void> {
    try {
      await this.store.set(issuer, record);
    } catch (err) {
      console.error(
        `authmd: failed to persist credentials for ${issuer}:`,
        err,
      );
    }
  }
}

/** Parse a JSON body, surfacing the HTTP status when the body is not JSON. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError(
      "invalid_response",
      `Non-JSON response (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      res.status,
    );
  }
}

function protocolError(status: number, body: unknown): ProtocolError {
  const parsed = body as ProtocolErrorBody;
  return new ProtocolError(
    parsed.error ?? "unknown_error",
    parsed.message ?? parsed.error_description ?? `HTTP ${status}`,
    status,
    parsed,
  );
}

function isLive(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() - EXPIRY_SLACK_MS > Date.now();
}

function secondsUntil(expiresAt: string): number {
  return Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
}
