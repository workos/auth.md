import { Router } from "express";
import { loginFormBody, parseBody } from "../schemas.js";
import { createUser, findUserByEmail, users } from "../store.js";

/*
 * Mock IdP. In production this would be a real authentication system
 * (AuthKit, your homegrown sign-in, etc.). We need just enough here to issue
 * a cookie-bound session so the /claim form can identify the signed-in user.
 * Session state is managed by express-session (see index.ts).
 */

export const loginRouter = Router();

loginRouter.get("/login", (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.return_to);
  if (req.session.userId) {
    res.redirect(returnTo);
    return;
  }
  renderLogin(res, 200, { returnTo });
});

loginRouter.post("/login", (req, res) => {
  const parsed = parseBody(loginFormBody, req.body);
  if (!parsed.ok) {
    renderLogin(res, 400, { returnTo: "/", error: parsed.message });
    return;
  }
  const email = parsed.value.email.toLowerCase();
  const returnTo = sanitizeReturnTo(parsed.value.return_to);

  let user = findUserByEmail(email);
  if (!user) {
    /*
     * Auto-provision unknown emails so demo testers don't have to seed
     * users. A real IdP would route to a sign-up flow with email
     * verification here.
     */
    user = createUser({ email, email_verified: true });
  }

  req.session.userId = user.id;
  console.log(`[login] signed in user=${user.id} email=${user.email}`);
  res.redirect(returnTo);
});

loginRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

function renderLogin(
  res: import("express").Response,
  status: number,
  locals: { returnTo: string; error?: string },
): void {
  res.status(status).render("login", {
    returnTo: locals.returnTo,
    error: locals.error ?? null,
    seededUsers: Array.from(users.values()).filter((u) => u.email_verified),
  });
}

/** Same-origin paths only. Anything else falls back to "/". */
function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
