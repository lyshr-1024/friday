import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env, stdio: "ignore" });

export function mainRepo(name = "app"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "friday-repo-")), name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

let seq = 0;
export function addTestWorktree(repoDir: string, name: string, branch = name): string {
  let path = join(dirname(repoDir), name);
  if (existsSync(path)) path = `${path}-${seq++}`;
  let hasBranch = true;
  try { git(repoDir, "rev-parse", "--verify", "-q", `refs/heads/${branch}`); } catch { hasBranch = false; }
  git(repoDir, "worktree", "add", "-q", ...(hasBranch ? ["-f", path, branch] : ["-b", branch, path]));
  return path;
}
