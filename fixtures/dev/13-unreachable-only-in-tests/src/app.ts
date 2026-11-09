import express from "express";
import _ from "lodash";

const app = express();

app.get("/tags", (req, res) => {
  res.json(_.uniq(["a", "b", "a"]));
});

app.listen(3000);
