import express from "express";
import _ from "lodash";

const app = express();
const defaults = { theme: "light" };

// Never called or referenced anywhere: this merge call is dead code.
function legacyImport(data: unknown) {
  return _.merge({}, defaults, data);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(3000);
