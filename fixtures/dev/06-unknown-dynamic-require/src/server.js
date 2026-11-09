const express = require("express");

const app = express();

app.post("/plugin/:name", (req, res) => {
  const plugin = require("./plugins/" + req.params.name);
  res.json(plugin.run(req.body));
});

app.listen(3000);
