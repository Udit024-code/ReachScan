import _ from "lodash";

const profiles: Record<string, object> = {};

export default function saveProfile(req: any, res: any) {
  profiles[req.user.id] = _.merge(profiles[req.user.id] ?? {}, req.body);
  res.sendStatus(204);
}
