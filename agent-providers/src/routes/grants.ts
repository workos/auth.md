import { Router } from "express";
import { requireSession } from "../auth.js";
import { mintLogoutJwt } from "../jwts.js";
import { createGrantBody, parseBody } from "../schemas.js";
import { grants, listGrantsForUser, upsertGrant } from "../store.js";

export const grantsRouter = Router();

grantsRouter.post("/grants", requireSession, (req, res) => {
  const parsed = parseBody(createGrantBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }
  const grant = upsertGrant({
    userId: req.user!.id,
    audience: parsed.value.audience,
    mode: parsed.value.mode,
    eventsUri: parsed.value.events_uri,
  });
  res.status(201).json(grant);
});

grantsRouter.get("/grants", requireSession, (req, res) => {
  res.json({ grants: listGrantsForUser(req.user!.id) });
});

grantsRouter.delete("/grants/:id", requireSession, async (req, res) => {
  const id = req.params.id ?? "";
  const grant = grants.get(id);

  if (!grant || grant.user_id !== req.user!.id) {
    res.status(404).json({ error: "not_found", message: "Grant not found." });
    return;
  }

  if (grant.events_uri) {
    let resp: Response;
    try {
      const logoutJwt = await mintLogoutJwt({
        user: req.user!,
        audience: grant.audience,
      });
      resp = await fetch(grant.events_uri, {
        method: "POST",
        headers: { "content-type": "application/secevent+jwt" },
        body: logoutJwt,
      });
    } catch (err) {
      console.warn("[revocation] outbound call failed:", err);
      res.status(500).json({
        error: "revocation_failed",
        message: `Failed to reach ${grant.events_uri}. Grant retained.`,
      });
      return;
    }
    if (!resp.ok) {
      console.warn(
        `[revocation] ${grant.events_uri} responded ${resp.status}; grant retained`,
      );
      res.status(500).json({
        error: "revocation_failed",
        message: `${grant.events_uri} responded ${resp.status}. Grant retained.`,
      });
      return;
    }
  }

  grants.delete(grant.id);
  res.status(204).end();
});
