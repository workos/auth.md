import { Router } from "express";
import { requireCredential } from "../auth.js";

export const apiRouter = Router();

apiRouter.get("/api/resource", requireCredential, (req, res) => {
  const user = req.user;
  const credential = req.credential!;
  res.json({
    message: "Success — credential accepted.",
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          email_verified: user.email_verified,
        }
      : null,
    credential: {
      scope: credential.scope,
      source: credential.source,
      iss: credential.iss,
      sub: credential.sub,
      aud: credential.aud,
      registration_id: credential.registration_id,
    },
  });
});
