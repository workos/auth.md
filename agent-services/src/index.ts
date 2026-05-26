import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { agentAuthRouter } from "./routes/agent-auth.js";
import { apiRouter } from "./routes/api.js";
import { authMdRouter } from "./routes/auth-md.js";
import { homeRouter } from "./routes/home.js";
import { mailRouter } from "./routes/mail.js";
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
  const app = express();
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json());
  app.use(accessLog);

  app.use(homeRouter);
  app.use(wellKnownRouter);
  app.use(authMdRouter);
  app.use(mailRouter);
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
      `[consumer] trusted issuers: ${config.trustedIssuers.join(", ")}`,
    );
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
