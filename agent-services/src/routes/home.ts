import { Router } from "express";
import { config } from "../config.js";

export const homeRouter = Router();

homeRouter.get("/", (_req, res) => {
  res.render("home", {
    providerHint: config.trustedIssuers[0]?.iss ?? "http://localhost:4000",
  });
});
