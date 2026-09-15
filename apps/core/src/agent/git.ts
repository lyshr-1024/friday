import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const LIMIT = 6000;

async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return `（git ${args[0]} 失败：${(err.stderr ?? err.message).trim()}）`;
  }
}

/** 最近 N 天的提交，给 Friday 自学挑题用；不是 git 仓库或没有提交就返回空数组。 */
/** 同步读当前分支名。onJobExit 是同步的，用不了上面那个异步 git()。
    读不到就返回空串——调用方要能接受「不知道分支」。 */
export function currentBranchSync(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

export async function recentCommits(dir: string, days: number, limit = 20): Promise<string[]> {
  const out = await git(dir, ["log", `--since=${days}.days`, "-n", String(limit), "--date=short", "--format=%ad %s"]);
  return out && !out.startsWith("（") ? out.split("\n") : [];
}

async function defaultBranch(dir: string): Promise<string> {
  const ref = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (ref.startsWith("origin/")) return ref;
  for (const b of ["main", "master"]) {
    if (!(await git(dir, ["rev-parse", "--verify", "--quiet", b])).startsWith("（")) return b;
  }
  return "HEAD";
}

/** 自主任务开工前的体检：返回拦下的理由，干净则 undefined。脏工作区上改代码，改动和用户自己的混在一起就分不清了。 */
export async function worktreeDirt(dir: string): Promise<string | undefined> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.trim() !== "true") return `${dir} 不是 git 仓库`;
  const status = await git(dir, ["status", "--porcelain"]);
  if (status.startsWith("（")) return status;
  const lines = status.split("\n").filter(Boolean);
  if (!lines.length) return undefined;
  return `工作区有 ${lines.length} 处未提交改动：${lines.slice(0, 5).map((l) => l.trim()).join("、")}${lines.length > 5 ? " 等" : ""}`;
}

export type GitInspect = "status" | "worktrees" | "log" | "branches";

export async function gitInspect(dir: string, what: GitInspect): Promise<string> {
  const out = await inspect(dir, what);
  return out.length > LIMIT ? `${out.slice(0, LIMIT)}\n…（已截断）` : out;
}

async function inspect(dir: string, what: GitInspect): Promise<string> {
  switch (what) {
    case "status": {
      const [branch, status, ahead] = await Promise.all([
        git(dir, ["branch", "--show-current"]),
        git(dir, ["status", "--short"]),
        git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
      ]);
      const [behind = "?", aheadN = "?"] = ahead.startsWith("（") ? [] : ahead.split(/\s+/);
      return [`分支：${branch}`, `相对上游：领先 ${aheadN}，落后 ${behind}`, status ? `未提交改动：\n${status}` : "工作区干净"].join("\n");
    }
    case "log":
      return git(dir, ["log", "--oneline", "-n", "15", "--date=short", "--format=%h %ad %s"]);
    case "branches": {
      const base = await defaultBranch(dir);
      const [merged, unmerged] = await Promise.all([
        git(dir, ["branch", "--merged", base, "--format=%(refname:short)"]),
        git(dir, ["branch", "--no-merged", base, "--format=%(refname:short) %(committerdate:short)"]),
      ]);
      return [`基准：${base}`, `未合并：\n${unmerged || "（无）"}`, `已合并：\n${merged || "（无）"}`].join("\n");
    }
    case "worktrees": {
      const base = await defaultBranch(dir);
      const porcelain = await git(dir, ["worktree", "list", "--porcelain"]);
      if (porcelain.startsWith("（")) return porcelain;
      const entries = porcelain.split("\n\n").filter(Boolean);
      const lines = await Promise.all(
        entries.map(async (block) => {
          const path = /^worktree (.+)$/m.exec(block)?.[1] ?? "?";
          const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
          if (!branch) return `${path}  (detached)`;
          const [merged, last, dirty] = await Promise.all([
            execFileP("git", ["-C", dir, "merge-base", "--is-ancestor", branch, base]).then(() => true).catch(() => false),
            git(dir, ["log", "-1", "--format=%ad %s", "--date=short", branch]),
            git(path, ["status", "--short"]),
          ]);
          const state = branch === base.replace(/^origin\//, "") ? "主分支" : merged ? "已合并" : "未合并";
          return `${path}\n  分支 ${branch} · ${state} · 最后提交 ${last}${dirty && !dirty.startsWith("（") ? `\n  有未提交改动 ${dirty.split("\n").length} 个文件` : ""}`;
        }),
      );
      return [`基准：${base}`, ...lines].join("\n");
    }
  }
}
