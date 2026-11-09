import path from "node:path";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";

const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** Directories and files that never run as part of the app. */
const EXCLUDED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

/**
 * Loads a repo's source files into a ts-morph project.
 * Nothing is installed or executed: files are only parsed and type-checked.
 */
export function loadProject(rootDir: string): { project: Project; root: string } {
  const root = toPosix(path.resolve(rootDir));
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      // Don't pick up @types from wherever the analyzer itself is installed.
      types: [],
      typeRoots: [],
    },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  project.addSourceFilesAtPaths([`${root}/${SOURCE_GLOB}`, ...EXCLUDED.map((glob) => `!${root}/${glob}`)]);
  return { project, root };
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function relativePath(root: string, filePath: string): string {
  return toPosix(path.relative(root, filePath));
}
