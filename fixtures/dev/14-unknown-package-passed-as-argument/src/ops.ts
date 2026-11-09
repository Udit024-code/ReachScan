// lib is the whole lodash object; op comes from the URL, so any lodash function can run.
export function applyOperation(lib: any, op: string, target: object, input: unknown) {
  return lib[op](target, input);
}
