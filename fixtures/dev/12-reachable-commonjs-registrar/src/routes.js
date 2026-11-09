const _ = require("lodash");

const store = {};

module.exports = function routes(app) {
  app.post("/store", (req, res) => {
    _.merge(store, req.body);
    res.json(store);
  });
};
