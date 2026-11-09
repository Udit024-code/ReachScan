import express from "express";
import merge from "lodash/merge";

const app = express();
const prefs = {};

function savePrefs(input: unknown) {
  return merge(prefs, input);
}

app.put("/prefs", (req, res) => {
  res.json(savePrefs(req.body));
});

app.listen(3000);
