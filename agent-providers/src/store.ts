import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";

export type User = {
  id: string;
  email: string;
  email_verified: boolean;
  name?: string;
  phone_number?: string;
  phone_number_verified?: boolean;
  auth_time: Date;
  amr?: string[];
};

export type Session = {
  token: string;
  user_id: string;
  created_at: Date;
};

export type GrantMode = "once" | "always";

export type Grant = {
  id: string;
  user_id: string;
  audience: string;
  mode: GrantMode;
  created_at: Date;
  expires_at: Date;
  consumed_at?: Date;
  events_uri?: string;
};

function addSeconds(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

export const users = new Map<string, User>();
export const sessions = new Map<string, Session>();
export const grants = new Map<string, Grant>();

const seedTime = new Date();
const seeded: User[] = [
  {
    id: "user_alice",
    email: "alice@example.com",
    email_verified: true,
    name: "Alice",
    auth_time: seedTime,
    amr: ["mfa"],
  },
  {
    id: "user_bob",
    email: "bob@example.com",
    email_verified: true,
    name: "Bob",
    auth_time: seedTime,
    amr: ["pwd"],
  },
];
for (const u of seeded) users.set(u.id, u);

export function findUserByEmail(email: string): User | undefined {
  const needle = email.toLowerCase();
  for (const u of users.values())
    if (u.email.toLowerCase() === needle) return u;
  return undefined;
}

export function createSession(userId: string): Session {
  const token = randomBytes(32).toString("base64url");
  const session: Session = { token, user_id: userId, created_at: new Date() };
  sessions.set(token, session);
  return session;
}

export function findGrantForAudience(
  userId: string,
  audience: string,
): Grant | undefined {
  const now = new Date();
  for (const g of grants.values()) {
    if (
      g.user_id === userId &&
      g.audience === audience &&
      g.expires_at > now &&
      !g.consumed_at
    )
      return g;
  }
  return undefined;
}

export function upsertGrant(input: {
  userId: string;
  audience: string;
  mode: GrantMode;
  eventsUri?: string;
}): Grant {
  const now = new Date();
  const existing = findGrantForAudience(input.userId, input.audience);
  if (existing) {
    existing.mode = input.mode;
    existing.expires_at = addSeconds(now, config.consentTtlSeconds);
    if (input.eventsUri) existing.events_uri = input.eventsUri;
    return existing;
  }
  const grant: Grant = {
    id: `grant_${randomUUID()}`,
    user_id: input.userId,
    audience: input.audience,
    mode: input.mode,
    created_at: now,
    expires_at: addSeconds(now, config.consentTtlSeconds),
    events_uri: input.eventsUri,
  };
  grants.set(grant.id, grant);
  return grant;
}

export function listGrantsForUser(userId: string): Grant[] {
  return Array.from(grants.values()).filter((g) => g.user_id === userId);
}
