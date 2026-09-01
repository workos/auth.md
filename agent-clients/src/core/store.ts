import crypto from "node:crypto";
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

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10 * 1000;
const LOCK_STALE_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StoreFile {
  version: 1;
  issuers: Record<string, IssuerRecord>;
}

export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  /** Serializes read-modify-write cycles within this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.AUTHMD_STORE_PATH ??
      path.join(os.homedir(), ".authmd", "credentials.json");
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Cross-process advisory lock: an exclusively created lockfile guards the
   * read-modify-write cycle so concurrent host processes (e.g. Claude and
   * Codex sharing ~/.authmd) can't discard each other's updates. Locks older
   * than LOCK_STALE_MS are treated as abandoned by a crashed process.
   */
  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        const ownIno = (await handle.stat()).ino;
        // Heartbeat: keep the lock's mtime fresh while held so other
        // processes don't mistake a live (but slow) holder for a stale lock.
        const heartbeat = setInterval(() => {
          const now = new Date();
          void fs.utimes(lockPath, now, now).catch(() => undefined);
        }, LOCK_STALE_MS / 3);
        heartbeat.unref();
        try {
          return await op();
        } finally {
          clearInterval(heartbeat);
          await handle.close();
          // Only remove the lock if it is still ours: a holder that was
          // suspended past LOCK_STALE_MS may have had its lock replaced,
          // and must not unlink the new holder's lockfile.
          const current = await fs.stat(lockPath).catch(() => undefined);
          if (current?.ino === ownIno) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const stat = await fs.stat(lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for credential store lock at ${lockPath}`,
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
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
    const tmp = `${this.filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async get(issuer: string): Promise<IssuerRecord | undefined> {
    const data = await this.read();
    return data.issuers[normalizeIssuer(issuer)];
  }

  async set(issuer: string, record: IssuerRecord): Promise<void> {
    await this.enqueue(() =>
      this.withLock(async () => {
        const data = await this.read();
        data.issuers[normalizeIssuer(issuer)] = record;
        await this.write(data);
      }),
    );
  }

  async delete(issuer: string): Promise<void> {
    await this.enqueue(() =>
      this.withLock(async () => {
        const data = await this.read();
        delete data.issuers[normalizeIssuer(issuer)];
        await this.write(data);
      }),
    );
  }
}

export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}
