import express from "express";
import { registerRoutes } from "./routes";

const app = express();
registerRoutes(app);
app.listen(3000);
