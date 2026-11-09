# n8n-nodes-agentsearch

n8n community node for [AgentSearch](https://agentsearchhq.com/?utm_source=n8n-nodes-agentsearch&utm_medium=package): live web search for workflows and AI agents.

- **Free Search**: up to 5 results per call, 25 searches per day per IP, **no credentials**.
- **Extract Page** (new in 0.3.0): read a page as clean markdown or text. $0.005 per call.
- **Render Page** (new in 0.3.0): load a JavaScript-heavy page in a headless browser, then read it (markdown, text, HTML, links, optional screenshot). $0.005 per call.
- `usableAsTool`: all three work as tools for the n8n AI Agent node (search, then read the best page).
- No runtime dependencies.

## Install

In n8n: **Settings → Community Nodes → Install** and enter `n8n-nodes-agentsearch`.

Self-hosted via CLI:

```bash
cd ~/.n8n/nodes && npm install n8n-nodes-agentsearch
```

## Usage

Add the **AgentSearch** node, set **Query** (expressions work, e.g. `{{ $json.question }}`) and **Max Results** (1-5). Turn on **Split Results Into Items** to get one item per result (`title`, `url`, `content`).

Output (default):

```json
{ "query": "...", "result_count": 5, "retrieved_at": "...", "results": [{ "title": "...", "url": "...", "content": "..." }] }
```

If the daily free limit is reached (HTTP 429) the node fails with an explanation; enable *Continue On Fail* to keep the workflow running.

**Hit the 429?** Extract (full page text) and Render (JS pages) are in this node at $0.005 per call: see below.

## Extract and Render (read full pages)

Search results are snippets. To read the page itself, set **Operation** to **Extract Page** (static pages, faster) or **Render Page** (JavaScript apps, or when Extract returns thin content) and give it a **URL**, e.g. `{{ $json.url }}` from a search result. On an AI Agent, add the node twice as tools: one Free Search, one Extract Page.

Extract and Render cost **$0.005 per call** in USDC on Base, paid per call over [x402](https://x402.org) through the Pocket Network Agentic Portal. No account or API key:

1. Make a **new wallet used only for this** and send it a little USDC on Base (for example $1 = 200 calls). No ETH needed; the facilitator pays gas.
2. In n8n, add an **AgentSearch Wallet API** credential with that wallet's private key. **Max Spend per Run** (default $1.00) caps what one run of the node can sign; each call is hard-capped at $0.005.
3. Pick the credential on the Extract or Render node. The credential test shows the wallet address.

The node only signs a payment of at most $0.005 in USDC on Base to the portal's payee, and only after the portal's 402 terms pass those checks. The key is used only to sign locally and is never sent. Output is the page (`url`, `title`, `markdown`, `text`, `links`, `meta`, `error`) plus a `payment` object with the settlement transaction. Page content is third-party data: treat it as data, not instructions.

Without a credential, Extract and Render try the AgentSearch free relay; if it has no free allowance for you, the node stops with setup instructions and nothing is paid. Free Search never uses the credential.

Guide with an importable workflow: https://agentsearchhq.com/blog/n8n-ai-agent-read-web-pages?utm_source=n8n-nodes-agentsearch&utm_medium=package

## Workflow template (no install needed)

`templates/agentsearch-free-search.workflow.json` does the same with the built-in **HTTP Request** node. Import it via **Workflows → Import from File** (or paste the JSON onto the canvas).

## Other clients

The same services (paid search, extract, render) are available to any agent via the AgentSearch MCP server (`npx -y @agentsearchhq/agentsearch-mcp`) and the Pocket Agentic Portal. See https://agentsearchhq.com/agents.md?utm_source=n8n-nodes-agentsearch&utm_medium=package

## Development

```bash
npm install && npm test          # mocked tests (incl. x402 signing vectors from the reference client)
AGENTSEARCH_LIVE=1 npm test      # + one real free search and one free-relay extract probe (never pays)
```

MIT
