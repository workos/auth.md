import { Router } from "express";
import { loginBody, parseBody } from "../schemas.js";
import { createSession, findUserByEmail } from "../store.js";

export const sessionRouter = Router();

sessionRouter.post("/login", (req, res) => {
  const parsed = parseBody(loginBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }

  const user = findUserByEmail(parsed.value.email);
  if (!user) {
    res.status(401).json({
      error: "unknown_user",
      message: "No seeded user with that email.",
    });
    return;
  }

  // Freshen auth_time so downstream resource servers can enforce a max_age
  // on the upstream authentication via the ID-JAG's auth_time claim.
  user.auth_time = new Date();

  const session = createSession(user.id);
  res.json({ session_token: session.token, user });
});
