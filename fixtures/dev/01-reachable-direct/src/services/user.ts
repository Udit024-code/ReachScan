import _ from "lodash";

const userSettings = { theme: "light" };

export function updateSettings(input: unknown) {
  _.merge(userSettings, input);
  return userSettings;
}
