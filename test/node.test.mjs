import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { AgentSearch, LIMIT_MESSAGE } = require("../dist/nodes/AgentSearch/AgentSearch.node.js");

function ctx(params, httpRequest) {
  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (n, _i, d) => (n in params ? params[n] : d),
    getNode: () => ({ name: "AgentSearch", type: "agentSearch" }),
    continueOnFail: () => false,
    helpers: { httpRequest },
  };
}
const node = new AgentSearch();

test("package.json n8n block", () => {
  const p = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.ok(p.keywords.includes("n8n-community-node-package"));
  assert.deepEqual(p.n8n.nodes, ["dist/nodes/AgentSearch/AgentSearch.node.js"]);
  assert.equal(node.description.credentials.length, 0);
});

test("free search (mocked) + split", async () => {
  let req;
  const [items] = await node.execute.call(ctx({ query: "q", maxResults: 2, split: true }, async (r) => { req = r; return { provider: "p", results: [{ url: "a" }, { url: "b" }] }; }));
  assert.equal(req.url, "https://relay.agentsearchhq.com/v1/search");
  assert.deepEqual(req.body, { query: "q", max_results: 2 });
  assert.equal(items.length, 2);
});

test("429 -> limit message", async () => {
  await assert.rejects(node.execute.call(ctx({ query: "q" }, async () => { throw Object.assign(new Error("x"), { httpCode: "429" }); })), (e) => e.message === LIMIT_MESSAGE);
});

test("template is valid workflow JSON using HTTP Request", () => {
  const w = JSON.parse(readFileSync(new URL("../templates/agentsearch-free-search.workflow.json", import.meta.url)));
  assert.ok(w.nodes.some((n) => n.type === "n8n-nodes-base.httpRequest"));
});

test("LIVE: real free search", { skip: !process.env.AGENTSEARCH_LIVE }, async () => {
  const [items] = await node.execute.call(ctx({ query: "n8n workflow automation", maxResults: 2 }, async (r) => {
    const res = await fetch(r.url, { method: r.method, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) });
    return res.json();
  }));
  assert.ok(items[0].json.results[0].url.startsWith("http"));
});
