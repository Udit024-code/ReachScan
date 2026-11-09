import _ from "lodash";

// Test-only code: merge is used to build test data and never ships with the app.
export const user = _.merge({ name: "test" }, { role: "admin" });
