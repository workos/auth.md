import type { AuthorizationServerMetadata } from "./types.js";
import { ProtocolError } from "./types.js";
import { normalizeIssuer } from "./store.js";

const METADATA_PATH = "/.well-known/oauth-authorization-server";

const cache = new Map<
  string,
  { metadata: AuthorizationServerMetadata; fetchedAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch (and cache) the authorization server metadata for an issuer,
 * including the `agent_auth` bootstrap block.
 */
export async function discover(
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  const base = normalizeIssuer(issuer);
  const cached = cache.get(base);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.metadata;
  }

  const res = await fetch(`${base}${METADATA_PATH}`);
  if (!res.ok) {
    throw new ProtocolError(
      "discovery_failed",
      `GET ${base}${METADATA_PATH} returned ${res.status}`,
      res.status,
    );
  }
  const metadata = (await res.json()) as AuthorizationServerMetadata;
  if (!metadata.agent_auth?.identity_endpoint) {
    throw new ProtocolError(
      "agent_auth_unsupported",
      `${base} does not advertise an agent_auth block; agentic registration is not supported`,
      200,
    );
  }
  cache.set(base, { metadata, fetchedAt: Date.now() });
  return metadata;
}
