/**
 * Wire types for the auth.md agentic registration protocol (v0.7.0),
 * mirroring AUTH.md and agent-services' response shapes.
 */

export type IdentityType = "anonymous" | "identity_assertion" | "service_auth";

export interface AgentAuthMetadata {
  skill?: string;
  identity_endpoint: string;
  claim_endpoint: string;
  events_endpoint?: string;
  identity_types_supported: IdentityType[];
  identity_assertion?: { assertion_types_supported: string[] };
  events_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  grant_types_supported?: string[];
  resource?: string;
  scopes_supported?: string[];
  agent_auth: AgentAuthMetadata;
}

export interface RefreshTokenBlock {
  value: string;
  expires_at: string;
}

export interface IdentityBlock {
  assertion: string;
  expires_at: string;
  refresh_token?: RefreshTokenBlock;
}

export interface ClaimAttemptBlock {
  verification_uri: string;
  expires_at: string;
}

export interface ClaimBlock {
  token: string;
  expires_at: string;
  url: string;
  attempt?: ClaimAttemptBlock;
}

export interface RegistrationResponse {
  id: string;
  type: IdentityType | "refresh";
  identity?: IdentityBlock;
  scopes?: string[] | { pre_claim?: string[]; post_claim?: string[] };
  claim?: ClaimBlock;
  /** Present on 401 interaction_required / login_required bodies. */
  error?: string;
  error_description?: string;
}

export interface ClaimAttemptResponse {
  id: string;
  type: "service_auth";
  attempt: ClaimAttemptBlock;
}

export interface ClaimCompleteResponse {
  id: string;
  status: string;
  identity: IdentityBlock;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface ProtocolErrorBody {
  error: string;
  message?: string;
  error_description?: string;
  max_age?: number;
}

/** Persisted per-issuer credential record (see store.ts). */
export interface IssuerRecord {
  registration_id: string;
  registration_type: IdentityType;
  claimed: boolean;
  identity?: IdentityBlock;
  access_token?: {
    value: string;
    expires_at: string;
    scope?: string;
  };
}

export type AuthenticateResult =
  | {
      status: "ready";
      access_token: string;
      token_type: string;
      expires_in: number;
      scope?: string;
      registration_id: string;
      registration_type: IdentityType;
      claimed: boolean;
    }
  | {
      status: "claim_required";
      registration_id: string;
      verification_uri: string;
      attempt_expires_at: string;
      instructions: string;
    };

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly body?: ProtocolErrorBody,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
