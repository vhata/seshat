import { execFile } from "node:child_process";

/** Git hooks export repository selectors which override even an explicit -C. */
export function cleanGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...environment };
  const localVariables = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  ];
  for (const key of Object.keys(clean)) {
    if (localVariables.includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete clean[key];
  }
  return clean;
}

/** Keep command output private: git errors can contain credentials and paths. */
export function git(
  directory: string,
  args: string[],
  allowedCodes: number[] = [0],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "-C", directory, ...args],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: cleanGitEnvironment() },
      (error, stdout) => {
        const code = error ? (error as { code?: number | string }).code : 0;
        if (typeof code === "number" && allowedCodes.includes(code)) resolve(stdout);
        else reject(new Error("A local git command failed; no checkout was changed."));
      },
    );
  });
}

/** Bash 3 case semantics, including brackets, escaping and stars across '/'. */
export function shellCaseMatches(value: string, pattern: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", 'case "$1" in $2) exit 0;; *) exit 1;; esac', "seshat-pattern", value, pattern],
      { encoding: "utf8" },
      (error) => {
        if (!error) resolve(true);
        else if ((error as { code?: number | string }).code === 1) resolve(false);
        else reject(new Error("Could not evaluate a survey exclusion pattern."));
      },
    );
  });
}
