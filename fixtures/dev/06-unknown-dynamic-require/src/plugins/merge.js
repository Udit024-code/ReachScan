const _ = require("lodash");

exports.run = function run(body) {
  return _.merge({}, body);
};
