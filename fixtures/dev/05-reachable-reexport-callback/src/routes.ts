import express from "express";
import { applyPatches } from "./services/profile";

export const router = express.Router();

router.route("/profile").put(handleUpdate);

function handleUpdate(req: any, res: any) {
  res.json(applyPatches({}, req.body.patches));
}
