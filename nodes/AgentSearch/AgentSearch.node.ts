import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

export const FREE_RELAY_URL = 'https://relay.agentsearchhq.com/v1/search';
export const CLIENT_TAG = 'n8n-nodes-agentsearch/0.2.4';
const DOCS = 'https://agentsearchhq.com/?utm_source=n8n-nodes-agentsearch&utm_medium=package';
export const LIMIT_MESSAGE =
	`Free AgentSearch limit reached (25 searches per day per IP; resets daily). For unlimited search plus extract (static pages) and render (JavaScript-heavy pages, or when extract returns thin content), use the paid API ($0.005 per call via the Pocket Agentic Portal, x402 USDC on Base). Docs: ${DOCS}`;

export class AgentSearch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AgentSearch',
		name: 'agentSearch',
		icon: { light: 'file:agentsearch.svg', dark: 'file:agentsearch.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Free live web search for AI agents (no credentials, 25 searches/day)',
		defaults: { name: 'AgentSearch' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Free Search', value: 'freeSearch', action: 'Search the web for free', description: 'Up to 5 results, 25 searches per day, no key' }],
				default: 'freeSearch',
			},
			{ displayName: 'Query', name: 'query', type: 'string', default: '', required: true, placeholder: 'latest n8n release' },
			{ displayName: 'Max Results', name: 'maxResults', type: 'number', typeOptions: { minValue: 1, maxValue: 5 }, default: 5 },
			{
				displayName: 'Split Results Into Items',
				name: 'split',
				type: 'boolean',
				default: false,
				description: 'Whether to output one item per result instead of one item with a results array',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const query = (this.getNodeParameter('query', i) as string).trim();
				if (!query) throw new NodeOperationError(this.getNode(), 'Query is empty', { itemIndex: i });
				const maxResults = this.getNodeParameter('maxResults', i, 5) as number;
				const split = this.getNodeParameter('split', i, false) as boolean;
				let res: IDataObject;
				try {
					res = await this.helpers.httpRequest({
						method: 'POST',
						url: FREE_RELAY_URL,
						body: { query, max_results: maxResults },
						headers: { 'X-Agent-Client': CLIENT_TAG },
						json: true,
						timeout: 30000,
					});
				} catch (e) {
					const err = e as { httpCode?: unknown; statusCode?: unknown; response?: { status?: unknown } };
					const status = err?.httpCode ?? err?.response?.status ?? err?.statusCode;
					if (String(status) === '429') throw new NodeOperationError(this.getNode(), LIMIT_MESSAGE, { itemIndex: i });
					throw new NodeApiError(this.getNode(), e as JsonObject, { itemIndex: i });
				}
				if (res && typeof res === 'object') delete res.provider;
				if (split) {
					for (const r of (res?.results as IDataObject[] | undefined) ?? []) out.push({ json: { query, ...r }, pairedItem: { item: i } });
				} else {
					out.push({ json: res, pairedItem: { item: i } });
				}
			} catch (e) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (e as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
