import _ from "lodash";

export class SettingsController {
  private settings = { theme: "light" };

  update(req: any, res: any) {
    _.merge(this.settings, req.body);
    res.json(this.settings);
  }
}
