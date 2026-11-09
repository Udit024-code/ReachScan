import express from "express";
import * as lodash from "lodash";

const app = express();
const config = { features: {} };

app.patch("/config", (req, res) => {
  lodash.merge(config, req.body);
  res.json(config);
});

app.listen(3000);
