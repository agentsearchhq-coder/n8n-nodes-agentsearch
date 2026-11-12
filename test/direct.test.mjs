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
const PRICES = { extract: "4000", render: "10000", search_and_read: "9000" };
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

test("direct refuses the Pocket payee, > $0.020, wrong network (nothing signed); pocket route refuses direct payee", async () => {
  for (const [route, over] of [["direct", { payTo: PORTAL_PAYEE }], ["direct", { amount: "20001" }], ["direct", { network: "eip155:84532" }], ["pocket", {}]]) {
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

test("direct searchAndRead: 402 -> signs 9000 to AgentSearch payee -> result + receipt", async () => {
  const v = vectors[0]; const calls = [];
  const http = async (r) => {
    calls.push(r);
    if (calls.length === 1) return { statusCode: 402, headers: { "payment-required": b64(terms("search_and_read")) }, body: {} };
    return { statusCode: 200, headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32) }) }, body: { query: "q", results: [{ url: "https://example.com/", markdown: "# Hi" }] } };
  };
  const [items] = await node.execute.call(ctx({ operation: "searchAndRead", query: "q", numResults: 3, searchAndReadMaxChars: 8000 }, http, { privateKey: v.key, maxSpendPerRunUsd: 1 }));
  assert.equal(calls[0].url, "https://api.agentsearchhq.com/x402/v1/search_and_read");
  assert.deepEqual(calls[0].body, { query: "q", num_results: 3, max_chars: 8000 });
  const sent = JSON.parse(Buffer.from(calls[1].headers["PAYMENT-SIGNATURE"], "base64").toString());
  assert.equal(sent.payload.authorization.to, DIRECT_PAYEE);
  assert.equal(sent.payload.authorization.value, "9000");
  assert.equal(items[0].json.payment.pay_to, DIRECT_PAYEE);
  assert.equal(items[0].json.payment.route, "agentsearch-x402-direct");
  assert.equal(items[0].json.payment.amount_atomic, "9000");
  assert.equal(items[0].json.payment.settled, true);
});

test("searchAndRead on the Pocket route refuses without signing", async () => {
  let n = 0;
  await assert.rejects(node.execute.call(ctx({ operation: "searchAndRead", query: "q" },
    async () => { n++; return { statusCode: 500, headers: {}, body: {} }; }, { privateKey: vectors[0].key, paymentRoute: "pocket" })), /own x402 API/);
  assert.equal(n, 0);
});

test("searchAndRead with no wallet refuses and never hits the free relay", async () => {
  let n = 0;
  const c = ctx({ operation: "searchAndRead", query: "q" }, async () => { n++; return { statusCode: 200, headers: {}, body: {} }; });
  c.getCredentials = async () => { throw new Error("Node does not have any credentials set"); };
  await assert.rejects(node.execute.call(c), /no wallet credential is set/i);
  assert.equal(n, 0);
});

// 0.7.0: News Search and Screenshot (direct x402 only), filters on news and Search and Read.
const PRICES07 = { news: "8000", screenshot: "10000", search_and_read: "9000" };
const terms07 = (path) => ({ x402Version: 2, resource: { url: `https://api.agentsearchhq.com/x402/v1/${path}` },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: PRICES07[path], asset: USDC_BASE, payTo: DIRECT_PAYEE, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] });
const paidHttp = (path, okBody, calls) => async (r) => {
  calls.push(r);
  if (calls.length === 1) return { statusCode: 402, headers: { "payment-required": b64(terms07(path)) }, body: {} };
  return { statusCode: 200, headers: { "payment-response": b64({ success: true, transaction: "0x" + "cd".repeat(32) }) }, body: okBody };
};
const wallet = () => ({ privateKey: vectors[0].key, maxSpendPerRunUsd: 1 });

test("0.7.0 news: pays $0.008 direct with max_results and filters", async () => {
  const calls = [];
  const [items] = await node.execute.call(ctx({ operation: "news", query: "base l2", newsMaxResults: 7,
    filters: { freshness: "day", country: "US", include_domains: "reuters.com, apnews.com", exclude_domains: "" } },
    paidHttp("news", { results: [{ title: "t", url: "https://reuters.com/x", date: "1 hour ago" }] }, calls), wallet()));
  assert.equal(calls[0].url, "https://api.agentsearchhq.com/x402/v1/news");
  assert.deepEqual(calls[0].body, { query: "base l2", max_results: 7, freshness: "day", country: "us", include_domains: ["reuters.com", "apnews.com"] });
  assert.equal(items[0].json.payment.amount_atomic, "8000");
  assert.equal(items[0].json.payment.service_id, "news");
  assert.equal(items[0].json.results.length, 1);
});

test("0.7.0 searchAndRead forwards filters", async () => {
  const calls = [];
  await node.execute.call(ctx({ operation: "searchAndRead", query: "q", filters: { language: "es", date_from: "2026-11-01" } },
    paidHttp("search_and_read", { results: [] }, calls), wallet()));
  assert.equal(calls[0].body.language, "es");
  assert.equal(calls[0].body.date_from, "2026-11-01");
});

test("0.7.0 screenshot: pays $0.010, returns binary image and no base64 in json", async () => {
  const calls = [];
  const png = Buffer.from("fakepng").toString("base64");
  const [items] = await node.execute.call(ctx({ operation: "screenshot", url: "https://example.com", screenshotFormat: "png",
    screenshotOptions: { fullPage: true, width: 390, height: 844 } },
    paidHttp("screenshot", { url: "https://example.com/", title: "Ex", screenshot: { format: "png", width: 390, height: 844, base64: png } }, calls), wallet()));
  assert.equal(calls[0].url, "https://api.agentsearchhq.com/x402/v1/screenshot");
  assert.deepEqual(calls[0].body, { url: "https://example.com", format: "png", full_page: true, viewport: { width: 390, height: 844 } });
  assert.equal(items[0].json.payment.amount_atomic, "10000");
  assert.equal(items[0].json.screenshot.base64, undefined);
  assert.equal(items[0].binary.data.mimeType, "image/png");
  assert.equal(items[0].binary.data.data, png);
});

for (const op of ["news", "screenshot"]) {
  test(`0.7.0 ${op}: no credential -> nothing signed, clear message`, async () => {
    const calls = [];
    await assert.rejects(node.execute.call(ctx({ operation: op, query: "q", url: "https://example.com" }, async (r) => { calls.push(r); }, undefined)), /paid operation/);
    assert.equal(calls.length, 0);
  });
  test(`0.7.0 ${op}: Pocket route refused before any request`, async () => {
    const calls = [];
    await assert.rejects(node.execute.call(ctx({ operation: op, query: "q", url: "https://example.com" }, async (r) => { calls.push(r); }, { ...wallet(), paymentRoute: "pocket" })), /only on AgentSearch's own x402 API/);
    assert.equal(calls.length, 0);
  });
}
