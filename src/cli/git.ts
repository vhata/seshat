import { execFile } from "node:child_process";

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
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
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
