import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { AgentSearch } = require("../dist/nodes/AgentSearch/AgentSearch.node.js");
const { AgentSearchWalletApi } = require("../dist/credentials/AgentSearchWalletApi.credentials.js");
const { DIRECT_PAYEE, PORTAL_PAYEE, USDC_BASE } = require("../dist/nodes/AgentSearch/x402.js");
const { vectors } = JSON.parse(readFileSync(new URL("./x402-vectors.json", import.meta.url)));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const node = new AgentSearch();
const PRICES = { extract: "7000", render: "10000" };
function ctx(params, httpRequest, creds) {
  return { getInputData: () => [{ json: {} }], getNodeParameter: (n, _i, d) => (n in params ? params[n] : d),
    getNode: () => ({ name: "AgentSearch", type: "agentSearch" }), getCredentials: async () => creds, continueOnFail: () => false, helpers: { httpRequest } };
}
const terms = (op, over = {}) => ({ x402Version: 2, resource: { url: `https://api.agentsearchhq.com/x402/v1/${op}` },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: PRICES[op], asset: USDC_BASE, payTo: DIRECT_PAYEE, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over }] });

test("credential: Payment Route defaults to direct since 0.5.0; Pocket stays selectable", () => {
  const p = new AgentSearchWalletApi().properties.find((x) => x.name === "paymentRoute");
  assert.equal(p.default, "direct");
  assert.deepEqual(p.options.map((o) => o.value), ["direct", "pocket"]);
});

for (const op of ["extract", "render"]) {
  test(`0.5.0 default: a credential with no Payment Route pays direct for ${op}`, async () => {
    const calls = [];
    const http = async (r) => {
      calls.push(r);
      if (calls.length === 1) return { statusCode: 402, headers: { "payment-required": b64(terms(op)) }, body: {} };
      return { statusCode: 200, headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32) }) }, body: { url: "https://example.com/", markdown: "# Hi" } };
    };
    const [items] = await node.execute.call(ctx({ operation: op, url: "https://example.com" }, http, { privateKey: vectors[0].key, maxSpendPerRunUsd: 1 }));
    assert.equal(calls[0].url, `https://api.agentsearchhq.com/x402/v1/${op}`);
    assert.equal(items[0].json.payment.pay_to, DIRECT_PAYEE);
  });
  test(`direct ${op}: 402 -> signs ${PRICES[op]} to AgentSearch payee -> raw result + receipt`, async () => {
    const v = vectors[0]; const calls = [];
    const http = async (r) => {
      calls.push(r);
      if (calls.length === 1) return { statusCode: 402, headers: { "payment-required": b64(terms(op)) }, body: {} };
      return { statusCode: 200, headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32) }) }, body: { url: "https://example.com/", markdown: "# Hi" } };
    };
    const params = { operation: op, url: "https://example.com", ...(op === "render" ? { renderFormats: ["markdown", "links"] } : {}) };
    const [items] = await node.execute.call(ctx(params, http, { privateKey: v.key, maxSpendPerRunUsd: 1, paymentRoute: "direct" }));
    assert.equal(calls[0].url, `https://api.agentsearchhq.com/x402/v1/${op}`);
    assert.deepEqual(calls[0].body, { url: "https://example.com" });
    const sent = JSON.parse(Buffer.from(calls[1].headers["PAYMENT-SIGNATURE"], "base64").toString());
    assert.equal(sent.payload.authorization.to, DIRECT_PAYEE);
    assert.equal(sent.payload.authorization.value, PRICES[op]);
    assert.equal(items[0].json.markdown, "# Hi");
    assert.equal(items[0].json.payment.pay_to, DIRECT_PAYEE);
    assert.equal(items[0].json.payment.route, "agentsearch-x402-direct");
    assert.equal(items[0].json.payment.settled, true);
    if (op === "render") assert.ok(items[0].json.payment.dropped_fields.includes("formats"));
  });
}

test("direct refuses the Pocket payee, > $0.010, wrong network (nothing signed); pocket route refuses direct payee", async () => {
  for (const [route, over] of [["direct", { payTo: PORTAL_PAYEE }], ["direct", { amount: "10001" }], ["direct", { network: "eip155:84532" }], ["pocket", {}]]) {
    let n = 0;
    const t = route === "pocket" ? { ...terms("extract"), resource: { url: "https://agent.pocket.network/v1/agentsearch-web-extract-v1" } } : terms("extract", over);
    await assert.rejects(node.execute.call(ctx({ operation: "extract", url: "https://example.com" },
      async () => { n++; return { statusCode: 402, headers: { "payment-required": b64(t) }, body: {} }; }, { privateKey: vectors[0].key, paymentRoute: route })), /Nothing was signed/);
    assert.equal(n, 1);
  }
});

const MOCK = process.env.AGENTSEARCH_TEST_DIRECT_MOCK; // e.g. http://127.0.0.1:8397 (x402-direct mock_mainnet_server.py)
test("E2E: direct extract + render against the local mock direct API (real signature check, no chain)", { skip: !MOCK }, async () => {
  const http = async (r) => {
    const res = await fetch(r.url.replace("https://api.agentsearchhq.com", MOCK), { method: r.method, headers: { "content-type": "application/json", ...(r.headers || {}) }, body: JSON.stringify(r.body) });
    const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
  };
  for (const op of ["extract", "render"]) {
    const [items] = await node.execute.call(ctx({ operation: op, url: "https://example.com" }, http, { privateKey: vectors[0].key, paymentRoute: "direct" }));
    assert.equal(items[0].json.payment.amount_atomic, PRICES[op]);
    assert.equal(items[0].json.payment.settled, true, JSON.stringify(items[0].json));
  }
});
