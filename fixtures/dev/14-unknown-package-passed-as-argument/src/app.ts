import express from "express";
import _ from "lodash";
import { applyOperation } from "./ops";

const app = express();
const doc = {};

app.post("/ops/:op", (req, res) => {
  res.json(applyOperation(_, req.params.op, doc, req.body));
});

app.listen(3000);
