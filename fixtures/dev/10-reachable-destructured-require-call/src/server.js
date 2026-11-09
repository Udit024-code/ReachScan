const express = require("express");
const { merge: deepMerge } = require("lodash");

const app = express();
const defaults = { retries: 3 };

function withDefaults(options) {
  return deepMerge({}, defaults, options);
}

app.post("/jobs", (req, res) => {
  const options = withDefaults.call(null, req.body);
  res.json(options);
});

app.listen(3000);
