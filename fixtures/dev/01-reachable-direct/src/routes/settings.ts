import { Router } from "express";
import { updateSettings } from "../services/user";

const router = Router();

router.post("/settings", (req, res) => {
  const saved = updateSettings(req.body);
  res.json(saved);
});

export default router;
