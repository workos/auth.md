import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IssuerRecord } from "./types.js";

/**
 * Per-issuer credential store. Everything is tenanted by the issuer URL, so
 * one client can hold independent registrations across many services.
 *
 * Default backend is a 0600 JSON file under ~/.authmd/. The interface is
 * pluggable so hosts can swap in an OS-keychain backend without touching
 * the client.
 */
export interface CredentialStore {
  get(issuer: string): Promise<IssuerRecord | undefined>;
  set(issuer: string, record: IssuerRecord): Promise<void>;
  delete(issuer: string): Promise<void>;
}

interface StoreFile {
  version: 1;
  issuers: Record<string, IssuerRecord>;
}

export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.AUTHMD_STORE_PATH ??
      path.join(os.homedir(), ".authmd", "credentials.json");
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoreFile;
    } catch {
      return { version: 1, issuers: {} };
    }
  }

  private async write(data: StoreFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async get(issuer: string): Promise<IssuerRecord | undefined> {
    const data = await this.read();
    return data.issuers[normalizeIssuer(issuer)];
  }

  async set(issuer: string, record: IssuerRecord): Promise<void> {
    const data = await this.read();
    data.issuers[normalizeIssuer(issuer)] = record;
    await this.write(data);
  }

  async delete(issuer: string): Promise<void> {
    const data = await this.read();
    delete data.issuers[normalizeIssuer(issuer)];
    await this.write(data);
  }
}

export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}
