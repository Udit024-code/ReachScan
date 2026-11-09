import express from "express";
import settingsRouter from "./routes/settings";

const app = express();
app.use(express.json());
app.use("/api", settingsRouter);
app.listen(3000);
