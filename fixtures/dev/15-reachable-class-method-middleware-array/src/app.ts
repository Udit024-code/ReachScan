import express from "express";
import { SettingsController } from "./controller";

const app = express();
const router = express.Router();
const controller = new SettingsController();

function requireAuth(req: any, res: any, next: () => void) {
  if (!req.user) return res.sendStatus(401);
  next();
}

router.put("/settings", [requireAuth, (req: any, res: any) => controller.update(req, res)]);

app.use("/api", router);
app.listen(3000);
