import { Hono } from "hono";
import type { ProjectKnowledge } from "@friday/shared";
import { bootstrapState, startKnowledgeBootstrap } from "../agent/knowledgeBootstrap.js";
import { record } from "../memory/audit.js";
import { deleteFeature, featureHistory, getFeature, listFeatures, writeKnowledge } from "../memory/features.js";
import { loadProjects } from "../memory/projects.js";

export const knowledge = new Hono()
  .get("/projects/:name/knowledge", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    if (!loadProjects().some((p) => p.name === name)) return c.json({ error: "注册表里没有这个项目" }, 404);
    const body: ProjectKnowledge = { features: listFeatures(name).map((f) => ({ ...f, history: featureHistory(f.id) })), ...bootstrapState(name) };
    return c.json(body);
  })
  .post("/projects/:name/knowledge/bootstrap", async (c) => {
    try {
      const r = await startKnowledgeBootstrap(decodeURIComponent(c.req.param("name")));
      return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .delete("/features/:id", (c) => {
    const f = getFeature(c.req.param("id"));
    if (!f) return c.json({ error: "没有这个功能" }, 404);
    const history = featureHistory(f.id);
    deleteFeature(f.id);
    record({ action: "feature_deleted", why: "你在项目页的知识库里删了它", how: `${f.project} · ${f.name}`, evidence: { feature: f, history }, risk: "irreversible" });
    writeKnowledge(f.project);
    return c.json({ ok: true });
  });
