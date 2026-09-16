import type { Snapshot, SummonEvent } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import { loadProjects } from "../../memory/projects.js";
import { buildRules, candidates, parseSlackTitle } from "./match.js";
import { summonCard } from "./card.js";

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";

export async function* summon(snapshot: Snapshot): AsyncGenerator<SummonEvent> {
  const tasks = listTasks(["collected", "understood", "processing", "review", "blocked"], 300);
  const projects = loadProjects();
  const { channel } = snapshot.app.bundleId === SLACK_BUNDLE ? parseSlackTitle(snapshot.app.title) : {};
  const input = { snapshot, tasks, projects, channel };
  const rules = buildRules(input);
  yield { type: "rules", rules };

  if (!rules.willThink) {
    yield { type: "done" };
    return;
  }

  try {
    const card = await summonCard({ snapshot, rules, candidates: candidates(input) });
    yield { type: "card", card };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
  yield { type: "done" };
}
