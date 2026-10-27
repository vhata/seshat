import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitEnvironment, readBuildIdentity, requireReleaseIdentity } from "./build-identity.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "seshat-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "--quiet");
  writeFileSync(join(root, "source.txt"), "first\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Initial fixture");
  return { root, git };
}

test("identity tracks commits, staged changes, unstaged changes and untracked files", (t) => {
  const { root, git } = fixture(t);
  const first = git("rev-parse", "HEAD");
  assert.deepEqual(readBuildIdentity(root), { commit: first, dirty: false });
  requireReleaseIdentity(readBuildIdentity(root));
  writeFileSync(join(root, "source.txt"), "second\n");
  assert.deepEqual(readBuildIdentity(root), { commit: first, dirty: true });
  assert.throws(() => requireReleaseIdentity(readBuildIdentity(root)), /clean Git checkout/);
  git("add", ".");
  assert.equal(readBuildIdentity(root).dirty, true);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Second fixture");
  const second = git("rev-parse", "HEAD");
  assert.notEqual(second, first);
  assert.deepEqual(readBuildIdentity(root), { commit: second, dirty: false });
  writeFileSync(join(root, "new.txt"), "untracked\n");
  assert.deepEqual(readBuildIdentity(root), { commit: second, dirty: true });
});

test("unknown Git identity cannot masquerade as a release", (t) => {
  const root = mkdtempSync(join(tmpdir(), "seshat-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readBuildIdentity(root), { commit: null, dirty: null });
  assert.throws(() => requireReleaseIdentity(readBuildIdentity(root)), /committed HEAD/);
});

test("inherited Git selectors cannot redirect the build identity", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const previous = new Map(names.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    GIT_DIR: join(b.root, ".git"), GIT_WORK_TREE: b.root,
    GIT_INDEX_FILE: join(b.root, ".git", "index"), GIT_COMMON_DIR: join(b.root, ".git"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true",
  });
  writeFileSync(join(a.root, "untracked.txt"), "dirty\n");
  assert.deepEqual(readBuildIdentity(a.root), { commit: a.git("rev-parse", "HEAD"), dirty: true });
  assert.deepEqual(readBuildIdentity(b.root), { commit: b.git("rev-parse", "HEAD"), dirty: false });
});
