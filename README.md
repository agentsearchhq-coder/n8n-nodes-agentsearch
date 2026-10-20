# n8n-nodes-agentsearch

n8n community node for [AgentSearch](https://agentsearchhq.com/?utm_source=n8n-nodes-agentsearch&utm_medium=package): live web search for workflows and AI agents.

- **Free Search** operation: up to 5 results per call, 25 searches per day per IP, **no credentials**.
- `usableAsTool`: works as a tool for the n8n AI Agent node.

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

## Workflow template (no install needed)

`templates/agentsearch-free-search.workflow.json` does the same with the built-in **HTTP Request** node. Import it via **Workflows → Import from File** (or paste the JSON onto the canvas).

## Paid API

Unlimited search plus page extract and JS render are $0.005 per call via the Pocket Agentic Portal (x402, USDC on Base). See https://agentsearchhq.com/agents.md?utm_source=n8n-nodes-agentsearch&utm_medium=package

## Development

```bash
npm install && npm test          # mocked tests
AGENTSEARCH_LIVE=1 npm test      # + one real free search
```

MIT
