import express from "express";
import _ from "lodash";

const app = express();
const store: Record<string, unknown> = {};

const handlers = {
  save: (body: unknown) => _.merge(store, body),
  read: () => store,
};

app.post("/action/:name", (req, res) => {
  const action = req.params.name as keyof typeof handlers;
  res.json(handlers[action](req.body));
});

app.listen(3000);
