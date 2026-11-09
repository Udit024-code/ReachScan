import { deepMerge } from "../utils";

export function applyPatches(target: object, patches: unknown[]) {
  patches.forEach((patch) => deepMerge(target, patch));
  return target;
}
