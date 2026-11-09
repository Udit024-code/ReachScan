const express = require("express");
const _ = require("lodash");

const app = express();
const users = [{ name: "a" }, { name: "b" }, { name: "a" }];

app.get("/names", (req, res) => {
  const names = _.uniq(users.map((u) => u.name));
  res.json(_.sortBy(names));
});

app.listen(3000);
