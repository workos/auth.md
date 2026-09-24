import cors from "cors";
import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { initKeys } from "./keys.js";
import { agentAuthRouter } from "./routes/agent-auth.js";
import { apiRouter } from "./routes/api.js";
import { authMdRouter } from "./routes/auth-md.js";
import { claimRouter } from "./routes/claim.js";
import { homeRouter } from "./routes/home.js";
import { loginRouter } from "./routes/login.js";
import { tokenRouter } from "./routes/token.js";
import { wellKnownRouter } from "./routes/well-known.js";

function accessLog(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`,
    );
  });
  next();
}

async function main() {
  await initKeys();

  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.use(express.static(path.join(__dirname, "public")));
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json());
  /*
   * The user-facing /login and /claim forms post application/x-www-form-
   * urlencoded. Agent API routes accept JSON only.
   */
  app.use(express.urlencoded({ extended: false }));
  /*
   * express-session with the default in-memory store. Fine for this demo;
   * production deployments should swap in a real store (Redis, Postgres,
   * etc.) — the MemoryStore will log a warning at startup reminding you.
   */
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV !== "development",
        sameSite: "lax",
        maxAge: config.sessionTtlSeconds * 1000,
      },
    }),
  );
  app.use(accessLog);

  app.use(homeRouter);
  app.use(wellKnownRouter);
  app.use(authMdRouter);
  app.use(loginRouter);
  app.use(claimRouter);
  app.use(agentAuthRouter);
  app.use(tokenRouter);
  app.use(apiRouter);

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[error]", err);
      if (res.headersSent) return;
      res.status(500).json({
        error: "internal_error",
        message: "An unexpected error occurred.",
      });
    },
  );

  app.listen(config.port, () => {
    console.log(`[consumer] listening on ${config.baseUrl}`);
    console.log(
      `[consumer] trusted issuers: ${config.trustedIssuers.map((i) => i.iss).join(", ")}`,
    );
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
