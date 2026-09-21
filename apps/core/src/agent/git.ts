import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
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

/**
 * 自主任务开工前的体检：返回拦下的理由，能开工则 undefined。
 * Friday 在独立 worktree 里干活，主仓脏不脏跟它无关——用户正改着自己的东西时
 * Friday 照样能开工，这正是用 worktree 的意义。只剩「得是个 git 仓库」这一条。
 */
export async function worktreeDirt(dir: string): Promise<string | undefined> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.trim() !== "true") return `${dir} 不是 git 仓库`;
  return undefined;
}

/** Friday 的 worktree 放这儿：跟 Claude Code 客户端同一个位置，用完即删，不混进 orca 的 workspace 列表。 */
export const fridayWorktree = (dir: string, jobId: string): string => join(dir, ".claude", "worktrees", `friday-${jobId.slice(0, 8)}`);

/**
 * 开一个 detached worktree。不预先建分支——分支名由终端里的 Claude 按项目规范起，
 * 它有完整上下文（任务标题多是中文，这边做 slug 会变乱码）。失败返回原因。
 */
/**
 * `base` 给了就从那条分支检出（二期在一期分支上接着开），否则从当前 HEAD。
 * 一律 --detach：分支名仍由终端里的 Claude 按项目规范自己起。
 */
export async function addWorktree(dir: string, path: string, base?: string): Promise<string | undefined> {
  const out = await git(dir, ["worktree", "add", "--detach", path, ...(base ? [base] : [])]);
  return out.startsWith("（") ? out : undefined;
}

export interface WorktreeCleanup {
  removed: boolean;
  branch?: string;
  branchDeleted: boolean;
  /** 没删成分支的原因，通常是「还没合并」——那不是错误，是安全阀 */
  kept?: string;
}

/**
 * 收掉一个 worktree。目录一律删（它只是个检出，删了不丢东西）；
 * 分支只用 -d 删，没合并的 git 会拒绝——被忽略的任务里可能有还想捡回来的改动，
 * 不能替用户做这个决定。
 */
export async function removeWorktree(dir: string, path: string): Promise<WorktreeCleanup> {
  const branch = currentBranchSync(path) || undefined;
  const rm = await git(dir, ["worktree", "remove", "--force", path]);
  const removed = !rm.startsWith("（");
  if (removed) await git(dir, ["worktree", "prune"]);
  if (!removed || !branch) return { removed, ...(branch ? { branch } : {}), branchDeleted: false };
  const del = await git(dir, ["branch", "-d", branch]);
  return del.startsWith("（")
    ? { removed, branch, branchDeleted: false, kept: "还没合并进主干，分支留着" }
    : { removed, branch, branchDeleted: true };
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

/**
 * 分支推上远端了没。这是本机能看到的、最接近「提测」的事实——
 * 真正的 MR 状态要调 GitLab/GitHub API，那是另一条集成，这版不做。
 * 推了不等于提测（可能只是备份），所以它是弱信号，由 stage 那边先问一句。
 */
export async function isPushed(dir: string, branch: string): Promise<boolean> {
  if (!dir || !branch) return false;
  const out = await git(dir, ["ls-remote", "--heads", "origin", branch]);
  return Boolean(out) && !out.startsWith("（") && out.includes(branch);
}
