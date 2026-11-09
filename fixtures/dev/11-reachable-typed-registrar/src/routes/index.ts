import type { Express } from "express";
import saveProfile from "../handlers/saveProfile";

export function registerRoutes(app: Express) {
  app.post("/profile", saveProfile);
}
