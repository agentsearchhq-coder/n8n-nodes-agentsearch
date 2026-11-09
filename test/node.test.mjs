import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { AgentSearch, LIMIT_MESSAGE, paidOnlyMessage } = require("../dist/nodes/AgentSearch/AgentSearch.node.js");
const { AgentSearchWalletApi } = require("../dist/credentials/AgentSearchWalletApi.credentials.js");
const { required, vectors } = JSON.parse(readFileSync(new URL("./x402-vectors.json", import.meta.url)));

function ctx(params, httpRequest, creds) {
  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (n, _i, d) => (n in params ? params[n] : d),
    getNode: () => ({ name: "AgentSearch", type: "agentSearch" }),
    getCredentials: async () => { if (!creds) throw new Error("Node does not have any credentials set"); return creds; },
    continueOnFail: () => false,
    helpers: { httpRequest },
  };
}
const node = new AgentSearch();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

test("package.json n8n block", () => {
  const p = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.ok(p.keywords.includes("n8n-community-node-package"));
  assert.deepEqual(p.n8n.nodes, ["dist/nodes/AgentSearch/AgentSearch.node.js"]);
  assert.deepEqual(p.n8n.credentials, ["dist/credentials/AgentSearchWalletApi.credentials.js"]);
  assert.equal(p.dependencies, undefined, "no runtime dependencies");
});

test("backward compatible: credential is optional and only shown for extract/render; freeSearch is the default", () => {
  const d = node.description;
  assert.equal(d.version, 1);
  assert.equal(d.credentials.length, 1);
  assert.equal(d.credentials[0].name, new AgentSearchWalletApi().name);
  assert.equal(d.credentials[0].required, false);
  assert.deepEqual(d.credentials[0].displayOptions.show.operation, ["extract", "render"]);
  const op = d.properties.find((p) => p.name === "operation");
  assert.equal(op.default, "freeSearch");
  assert.deepEqual(op.options.map((o) => o.value), ["freeSearch", "extract", "render"]);
});

test("free search (mocked) + split, no credentials touched", async () => {
  let req;
  const c = ctx({ query: "q", maxResults: 2, split: true }, async (r) => { req = r; return { provider: "p", results: [{ url: "a" }, { url: "b" }] }; });
  c.getCredentials = async () => { throw new Error("must not be called"); };
  const [items] = await node.execute.call(c);
  assert.equal(req.url, "https://relay.agentsearchhq.com/v1/search");
  assert.deepEqual(req.body, { query: "q", max_results: 2 });
  assert.equal(items.length, 2);
});

test("free search on a 0.2.x workflow (no operation param stored)", async () => {
  const [items] = await node.execute.call(ctx({ query: "q" }, async () => ({ results: [] })));
  assert.equal(items.length, 1);
});

test("429 -> limit message", async () => {
  await assert.rejects(node.execute.call(ctx({ query: "q" }, async () => { throw Object.assign(new Error("x"), { httpCode: "429" }); })), (e) => e.message === LIMIT_MESSAGE);
});

test("extract without wallet: relay has no free extract (404) -> setup message, nothing paid", async () => {
  const calls = [];
  await assert.rejects(
    node.execute.call(ctx({ operation: "extract", url: "https://example.com" }, async (r) => { calls.push(r.url); return { statusCode: 404, headers: {}, body: { detail: "Not Found" } }; })),
    (e) => e.message === paidOnlyMessage("extract"),
  );
  assert.deepEqual(calls, ["https://relay.agentsearchhq.com/v1/extract"]);
});

test("extract without wallet: free trial relay answers 200", async () => {
  const [items] = await node.execute.call(ctx({ operation: "extract", url: "https://example.com", extractFormats: ["markdown"], maxChars: 500 }, async (r) => {
    assert.deepEqual(r.body, { url: "https://example.com", formats: ["markdown"], max_chars: 500 });
    return { statusCode: 200, headers: {}, body: { url: "https://example.com", markdown: "# Example", provider: "x" } };
  }));
  assert.equal(items[0].json.markdown, "# Example");
  assert.equal(items[0].json.free_trial, true);
  assert.equal(items[0].json.provider, undefined);
});

test("extract with wallet: 402 -> signs once within limits -> paid 200", async () => {
  const v = vectors[0];
  const calls = [];
  const http = async (r) => {
    calls.push(r);
    if (calls.length === 1) return { statusCode: 402, headers: { "payment-required": b64(required) }, body: {} };
    return {
      statusCode: 200,
      headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: v.from }) },
      body: { portal: { serviceId: "agentsearch-web-extract-v1" }, data: { url: "https://example.com", markdown: "# Hi", error: null } },
    };
  };
  const [items] = await node.execute.call(ctx({ operation: "extract", url: "https://example.com" }, http, { privateKey: v.key, maxSpendPerRunUsd: 1 }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://agent.pocket.network/v1/agentsearch-web-extract-v1/v1/extract");
  assert.equal(calls[0].headers["PAYMENT-SIGNATURE"], undefined);
  const sent = JSON.parse(Buffer.from(calls[1].headers["PAYMENT-SIGNATURE"], "base64").toString());
  assert.equal(sent.payload.authorization.from, v.from);
  assert.equal(sent.payload.authorization.value, "5000");
  assert.equal(sent.payload.authorization.to, "0xF732ea490c5766071785a2310523f7fA2CEbB829");
  assert.match(sent.payload.signature, /^0x[0-9a-f]{130}$/);
  assert.equal(items[0].json.markdown, "# Hi");
  assert.equal(items[0].json.payment.amount_usd, "$0.005000");
  assert.equal(items[0].json.payment.settled, true);
  assert.ok(!JSON.stringify(items[0].json).includes(v.key.slice(2)), "key never in output");
});

test("render with wallet uses the render service and options", async () => {
  const calls = [];
  const renderReq = { ...required, resource: { ...required.resource, url: "https://agent.pocket.network/v1/agentsearch-web-render-v1" } };
  const http = async (r) => {
    calls.push(r);
    if (calls.length === 1) return { statusCode: 402, headers: { "PAYMENT-REQUIRED": b64(renderReq) }, body: {} };
    return { statusCode: 200, headers: {}, body: { data: { url: "https://x.dev", markdown: "app" } } };
  };
  const [items] = await node.execute.call(ctx({ operation: "render", url: "https://x.dev", renderFormats: ["markdown", "links"], maxChars: 1000, renderOptions: { waitUntil: "networkidle", waitMs: 500 } }, http, { privateKey: vectors[1].key }));
  assert.equal(calls[0].url, "https://agent.pocket.network/v1/agentsearch-web-render-v1/v1/render");
  assert.deepEqual(calls[0].body, { url: "https://x.dev", formats: ["markdown", "links"], max_chars: 1000, wait_until: "networkidle", wait_ms: 500 });
  assert.equal(items[0].json.payment.settled, false);
});

test("refuses to sign for a different payee or a higher price", async () => {
  for (const bad of [{ payTo: "0x000000000000000000000000000000000000dEaD" }, { amount: "6000" }]) {
    let n = 0;
    const r2 = { ...required, accepts: [{ ...required.accepts[0], ...bad }] };
    await assert.rejects(
      node.execute.call(ctx({ operation: "extract", url: "https://example.com" }, async () => { n++; return { statusCode: 402, headers: { "payment-required": b64(r2) }, body: {} }; }, { privateKey: vectors[0].key })),
      /Nothing was signed/,
    );
    assert.equal(n, 1, "no paid retry");
  }
});

test("per-run spend cap stops signing", async () => {
  let n = 0;
  const c = ctx({ operation: "extract", url: "https://example.com" }, async () => { n++; return n % 2 ? { statusCode: 402, headers: { "payment-required": b64(required) }, body: {} } : { statusCode: 200, headers: {}, body: { data: {} } }; }, { privateKey: vectors[0].key, maxSpendPerRunUsd: 0.005 });
  c.getInputData = () => [{ json: {} }, { json: {} }];
  await assert.rejects(node.execute.call(c), /Spend cap reached/);
  assert.equal(n, 2, "second item never contacted the portal");
});

test("credential test validates key and shows the address", async () => {
  const fn = node.methods.credentialTest.agentSearchWalletTest;
  const ok = await fn.call({}, { data: { privateKey: vectors[1].key, maxSpendPerRunUsd: 1 } });
  assert.equal(ok.status, "OK");
  assert.ok(ok.message.includes(vectors[1].from));
  const bad = await fn.call({}, { data: { privateKey: "secret-not-a-key" } });
  assert.equal(bad.status, "Error");
  assert.ok(!bad.message.includes("secret-not-a-key"));
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

test("LIVE: extract without wallet reaches relay and explains setup", { skip: !process.env.AGENTSEARCH_LIVE }, async () => {
  const http = async (r) => {
    const res = await fetch(r.url, { method: r.method, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) });
    const text = await res.text();
    let body = text; try { body = JSON.parse(text); } catch {}
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
  };
  try {
    const [items] = await node.execute.call(ctx({ operation: "extract", url: "https://example.com" }, http));
    assert.equal(items[0].json.free_trial, true);
  } catch (e) {
    assert.match(e.message, /wallet|allowance/i);
  }
});
