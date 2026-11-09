import express from "express";
import _ from "lodash";

const app = express();

app.post("/merge", (req, res) => {
  // The lodash wrapper exposes merge as a method; it is never called as _.merge.
  const wrapped = _.chain({});
  res.json(wrapped.merge(req.body).value());
});

app.listen(3000);
