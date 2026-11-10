import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	addressOf,
	atomicToUsd,
	BASE_NETWORK,
	createPaymentPayload,
	decodeBase64Json,
	encodePaymentHeader,
	MAX_PER_CALL_ATOMIC,
	parsePrivateKey,
	PORTAL_PAYEE,
	DIRECT_MAX_PER_CALL_ATOMIC,
	DIRECT_PAYEE,
	DIRECT_URL,
	selectAccept,
	USDC_BASE,
	type PaymentRequired,
} from './x402';

export const FREE_RELAY_URL = 'https://relay.agentsearchhq.com/v1/search';
export const RELAY_BASE_URL = 'https://relay.agentsearchhq.com';
export const PORTAL_URL = 'https://agent.pocket.network';
export const CLIENT_TAG = 'n8n-nodes-agentsearch/0.5.0';
const DOCS = 'https://agentsearchhq.com/?utm_source=n8n-nodes-agentsearch&utm_medium=package';
const GUIDE = 'https://agentsearchhq.com/blog/n8n-ai-agent-read-web-pages?utm_source=n8n-nodes-agentsearch&utm_medium=package';
export const LIMIT_MESSAGE =
	`Free AgentSearch limit reached (25 searches per day per IP; resets daily). For unlimited search plus extract (static pages) and render (JavaScript-heavy pages, or when extract returns thin content), use the paid API (AgentSearch's own x402 API on Base: Extract $0.007, Render $0.010 per call in USDC; Pocket route $0.005 optional). Docs: ${DOCS}`;

type PageOperation = 'extract' | 'render';
export const PORTAL_SERVICES: Record<PageOperation, { serviceId: string; path: string }> = {
	extract: { serviceId: 'agentsearch-web-extract-v1', path: '/v1/extract' },
	render: { serviceId: 'agentsearch-web-render-v1', path: '/v1/render' },
};

export const WALLET_SETUP =
	'Add an "AgentSearch Wallet API" credential to this node: the private key of a NEW wallet made only for this, funded with a little USDC on Base (for example $1 = about 100-140 calls; no ETH needed). Each call is paid over x402 to AgentSearch\'s own API on Base (Extract $0.007, Render $0.010; failed calls are not charged), or $0.005 through the Pocket Network Agentic Portal if you pick that Payment Route. Free Search stays free and needs no credential. Guide: ' +
	GUIDE;

export function paidOnlyMessage(op: PageOperation): string {
	return `${op === 'extract' ? 'Extract' : 'Render'} is a paid operation (${op === 'extract' ? '$0.007' : '$0.010'} per call in USDC on Base via x402) and no wallet credential is set, so nothing was paid. ${WALLET_SETUP}`;
}
export function trialLimitMessage(op: PageOperation): string {
	return `Free ${op} allowance for today is used up. Continue at ${op === 'extract' ? '$0.007' : '$0.010'} per call (x402, USDC on Base): ${WALLET_SETUP}`;
}

const headerOf = (headers: unknown, name: string): string | undefined => {
	const h = (headers ?? {}) as Record<string, unknown>;
	const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
	const v = key ? h[key] : undefined;
	return Array.isArray(v) ? String(v[0]) : v === undefined || v === null ? undefined : String(v);
};

interface FullResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	body: unknown;
}

function errorText(body: unknown): string {
	const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	if (e && typeof e === 'object') return `${String(e.code ?? '')} ${String(e.message ?? '')}`.trim();
	if (typeof body === 'string') return body.slice(0, 300);
	try {
		return JSON.stringify(body).slice(0, 300);
	} catch {
		return '';
	}
}

export class AgentSearch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AgentSearch',
		name: 'agentSearch',
		icon: { light: 'file:agentsearch.svg', dark: 'file:agentsearch.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Free live web search for AI agents, plus page Extract ($0.007) and JavaScript Render ($0.010) per call via x402',
		defaults: { name: 'AgentSearch' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'agentSearchWalletApi',
				required: false,
				testedBy: 'agentSearchWalletTest',
				displayOptions: { show: { operation: ['extract', 'render'] } },
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Free Search', value: 'freeSearch', action: 'Search the web for free', description: 'Up to 5 results, 25 searches per day, no key' },
					{
						name: 'Extract Page',
						value: 'extract',
						action: 'Extract a page as markdown',
						description: 'Read a page as clean markdown or text ($0.007 per call, wallet credential)',
					},
					{
						name: 'Render Page',
						value: 'render',
						action: 'Render a dynamic page',
						description: 'Load a JavaScript-heavy page in a headless browser and read it ($0.010 per call, wallet credential)',
					},
				],
				default: 'freeSearch',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'latest n8n release',
				displayOptions: { show: { operation: ['freeSearch'] } },
			},
			{
				displayName: 'Max Results',
				name: 'maxResults',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5 },
				default: 5,
				displayOptions: { show: { operation: ['freeSearch'] } },
			},
			{
				displayName: 'Split Results Into Items',
				name: 'split',
				type: 'boolean',
				default: false,
				description: 'Whether to output one item per result instead of one item with a results array',
				displayOptions: { show: { operation: ['freeSearch'] } },
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/article',
				description: 'Absolute public http(s) URL of the page to read',
				displayOptions: { show: { operation: ['extract', 'render'] } },
			},
			{
				displayName: 'Formats',
				name: 'extractFormats',
				type: 'multiOptions',
				options: [
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Text', value: 'text' },
				],
				default: ['markdown'],
				description: 'Renderings to return',
				displayOptions: { show: { operation: ['extract'] } },
			},
			{
				displayName: 'Formats',
				name: 'renderFormats',
				type: 'multiOptions',
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'Links', value: 'links' },
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Text', value: 'text' },
				],
				default: ['markdown'],
				description: 'Renderings of the rendered page to return',
				displayOptions: { show: { operation: ['render'] } },
			},
			{
				displayName: 'Max Characters',
				name: 'maxChars',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100000 },
				default: 20000,
				description: 'Cap on returned characters per format',
				displayOptions: { show: { operation: ['extract', 'render'] } },
			},
			{
				displayName: 'Options',
				name: 'renderOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['render'] } },
				options: [
					{
						displayName: 'Block Resources',
						name: 'block',
						type: 'multiOptions',
						options: [
							{ name: 'Font', value: 'font' },
							{ name: 'Image', value: 'image' },
							{ name: 'Media', value: 'media' },
							{ name: 'Stylesheet', value: 'stylesheet' },
						],
						default: ['media', 'font'],
						description: 'Resource types to block while rendering',
					},
					{
						displayName: 'Full Page Screenshot',
						name: 'fullPage',
						type: 'boolean',
						default: false,
						description: 'Whether to capture the full page height (clipped to 4000 px) when taking a screenshot',
					},
					{
						displayName: 'Screenshot',
						name: 'screenshot',
						type: 'boolean',
						default: false,
						description: 'Whether to also capture a screenshot, returned as base64',
					},
					{
						displayName: 'Wait For Selector',
						name: 'waitForSelector',
						type: 'string',
						default: '',
						description: 'CSS selector to wait for (at most 1.5 s) before reading the page',
					},
					{
						displayName: 'Wait Milliseconds',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1500 },
						default: 0,
						description: 'Extra fixed wait after load (0-1500 ms)',
					},
					{
						displayName: 'Wait Until',
						name: 'waitUntil',
						type: 'options',
						options: [
							{ name: 'DOM Content Loaded', value: 'domcontentloaded' },
							{ name: 'Load', value: 'load' },
							{ name: 'Network Idle', value: 'networkidle' },
						],
						default: 'domcontentloaded',
						description: 'Navigation event to wait for before reading the page',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async agentSearchWalletTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const data = (credential.data ?? {}) as ICredentialDataDecryptedObject;
				let address: string;
				try {
					address = addressOf(parsePrivateKey(String(data.privateKey ?? '')));
				} catch (e) {
					return { status: 'Error', message: (e as Error).message };
				}
				const cap = Number(data.maxSpendPerRunUsd ?? 1);
				if (!Number.isFinite(cap) || cap <= 0) return { status: 'Error', message: 'Max Spend per Run must be a positive number of USD.' };
				return {
					status: 'OK',
					message: `Valid key for wallet ${address}. Fund it with USDC on Base (no ETH needed); each Extract ($0.007) or Render ($0.010) call pays AgentSearch's x402 API ($0.005 on the Pocket route).`,
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		let signedAtomic = 0n;
		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i, 'freeSearch') as string;
				if (operation === 'extract' || operation === 'render') {
					const r = await readPage.call(this, operation, i, signedAtomic);
					signedAtomic = r.signedAtomic;
					out.push({ json: r.json, pairedItem: { item: i } });
					continue;
				}
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

function buildBody(this: IExecuteFunctions, op: PageOperation, i: number): IDataObject {
	const url = String(this.getNodeParameter('url', i) ?? '').trim();
	if (!/^https?:\/\/\S+$/i.test(url)) throw new NodeOperationError(this.getNode(), 'URL must be an absolute http(s) URL', { itemIndex: i });
	const maxChars = this.getNodeParameter('maxChars', i, 20000) as number;
	if (op === 'extract') {
		const formats = this.getNodeParameter('extractFormats', i, ['markdown']) as string[];
		return { url, formats: formats?.length ? formats : ['markdown'], max_chars: maxChars };
	}
	const formats = this.getNodeParameter('renderFormats', i, ['markdown']) as string[];
	const o = this.getNodeParameter('renderOptions', i, {}) as IDataObject;
	const body: IDataObject = { url, formats: formats?.length ? formats : ['markdown'], max_chars: maxChars };
	if (o.waitUntil) body.wait_until = o.waitUntil;
	if (typeof o.waitForSelector === 'string' && o.waitForSelector.trim()) body.wait_for_selector = o.waitForSelector.trim();
	if (typeof o.waitMs === 'number' && o.waitMs > 0) body.wait_ms = o.waitMs;
	if (Array.isArray(o.block)) body.block = o.block;
	if (o.screenshot === true) body.screenshot = true;
	if (o.fullPage === true) body.full_page = true;
	return body;
}

async function post(this: IExecuteFunctions, url: string, body: IDataObject, headers: IDataObject = {}): Promise<FullResponse> {
	const req: IHttpRequestOptions = {
		method: 'POST',
		url,
		body,
		headers: { 'X-Agent-Client': CLIENT_TAG, accept: 'application/json', ...headers },
		json: true,
		timeout: 60000,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	return (await this.helpers.httpRequest(req)) as FullResponse;
}

async function readPage(
	this: IExecuteFunctions,
	op: PageOperation,
	i: number,
	signedBefore: bigint,
): Promise<{ json: IDataObject; signedAtomic: bigint }> {
	const body = buildBody.call(this, op, i);
	let creds: ICredentialDataDecryptedObject | undefined;
	try {
		creds = await this.getCredentials<ICredentialDataDecryptedObject>('agentSearchWalletApi', i);
	} catch {
		creds = undefined; // no wallet credential attached: use the free allowance if the relay offers one
	}

	if (!creds?.privateKey) {
		const { path } = PORTAL_SERVICES[op];
		const res = await post.call(this, `${RELAY_BASE_URL}${path}`, body);
		if (res.statusCode >= 200 && res.statusCode < 300) {
			const data = res.body && typeof res.body === 'object' ? (res.body as IDataObject) : { result: res.body as string };
			delete data.provider;
			return { json: { ...data, free_trial: true }, signedAtomic: signedBefore };
		}
		if (res.statusCode === 429) throw new NodeOperationError(this.getNode(), trialLimitMessage(op), { itemIndex: i });
		if ([401, 402, 403, 404, 405].includes(res.statusCode)) throw new NodeOperationError(this.getNode(), paidOnlyMessage(op), { itemIndex: i });
		throw new NodeOperationError(this.getNode(), `AgentSearch free ${op} failed (HTTP ${res.statusCode}): ${errorText(res.body)}`, { itemIndex: i });
	}

	let key: bigint;
	try {
		key = parsePrivateKey(String(creds.privateKey));
	} catch (e) {
		throw new NodeOperationError(this.getNode(), (e as Error).message, { itemIndex: i });
	}
	const capUsd = Number(creds.maxSpendPerRunUsd ?? 1);
	const capAtomic = BigInt(Math.round((Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 1) * 1_000_000));
	const remaining = capAtomic - signedBefore;
	// 0.5.0: direct is the default; only an explicit 'pocket' uses the Pocket portal.
	const direct = creds.paymentRoute !== 'pocket';
	const hardCap = direct ? DIRECT_MAX_PER_CALL_ATOMIC : MAX_PER_CALL_ATOMIC;
	const payee = direct ? DIRECT_PAYEE : PORTAL_PAYEE;
	const ceiling = remaining < hardCap ? remaining : hardCap;
	if (ceiling <= 0n) {
		throw new NodeOperationError(
			this.getNode(),
			`Spend cap reached for this run: ${atomicToUsd(signedBefore)} of ${atomicToUsd(capAtomic)} signed. Raise "Max Spend per Run" on the AgentSearch Wallet API credential to spend more. Nothing was signed.`,
			{ itemIndex: i },
		);
	}

	const { serviceId, path } = PORTAL_SERVICES[op];
	const url = direct ? `${DIRECT_URL}/x402/v1/${op}` : `${PORTAL_URL}/v1/${serviceId}${path}`;
	const expectRes = direct ? `/x402/v1/${op}` : `/v1/${serviceId}`;
	// The direct API reads only {url}; other options are dropped (and reported).
	const dropped = direct ? Object.keys(body).filter((k) => k !== 'url') : [];
	const sendBody: IDataObject = direct ? { url: body.url } : body;

	// 1) Unpaid request: expect 402 with the PAYMENT-REQUIRED terms.
	const unpaid = await post.call(this, url, sendBody);
	if (unpaid.statusCode !== 402) {
		throw new NodeOperationError(
			this.getNode(),
			`${direct ? 'The AgentSearch x402 API' : 'The payment portal'} answered ${unpaid.statusCode} before payment: ${errorText(unpaid.body)}. Nothing was signed.`,
			{ itemIndex: i },
		);
	}
	let required: PaymentRequired;
	try {
		required = decodeBase64Json<PaymentRequired>(headerOf(unpaid.headers, 'payment-required') ?? '');
	} catch {
		throw new NodeOperationError(this.getNode(), "The portal's 402 is not valid x402 v2. Nothing was signed.", { itemIndex: i });
	}
	if (required?.x402Version !== 2) throw new NodeOperationError(this.getNode(), 'Unsupported x402 version. Nothing was signed.', { itemIndex: i });
	const resUrl = String(required.resource?.url ?? '');
	if (!resUrl.replace(/\/+$/, '').endsWith(expectRes)) {
		throw new NodeOperationError(this.getNode(), `The 402 is for ${resUrl}, not ${expectRes}. Nothing was signed.`, { itemIndex: i });
	}

	// 2) Every limit is checked before signing.
	let accepted;
	try {
		accepted = selectAccept(required.accepts, ceiling, payee);
	} catch (e) {
		throw new NodeOperationError(this.getNode(), (e as Error).message, { itemIndex: i });
	}
	const amount = BigInt(accepted.amount);
	const { payload, from } = createPaymentPayload(required, accepted, key);
	const signedAtomic = signedBefore + amount; // counted at signing: a signed authorization may be settled

	// 3) Retry once with PAYMENT-SIGNATURE.
	let paid: FullResponse;
	try {
		paid = await post.call(this, url, sendBody, { 'PAYMENT-SIGNATURE': encodePaymentHeader(payload) });
	} catch (e) {
		throw new NodeOperationError(
			this.getNode(),
			`A payment of ${atomicToUsd(amount)} was signed but the paid request failed (${(e as Error).message}). It may or may not be settled; check the wallet before retrying.`,
			{ itemIndex: i },
		);
	}
	if (paid.statusCode < 200 || paid.statusCode >= 300) {
		throw new NodeOperationError(
			this.getNode(),
			`${direct ? 'The AgentSearch x402 API' : 'The portal'} answered ${paid.statusCode}: ${errorText(paid.body)}. A non-2xx answer is not settled, so you should not be charged.`,
			{ itemIndex: i },
		);
	}
	let receipt: { success?: boolean; transaction?: string } | undefined;
	const rh = headerOf(paid.headers, 'payment-response');
	if (rh) {
		try {
			receipt = decodeBase64Json(rh);
		} catch {
			receipt = undefined;
		}
	}
	const envelope = (paid.body ?? {}) as { data?: IDataObject; portal?: IDataObject };
	const data = direct
		? (paid.body && typeof paid.body === 'object' ? (paid.body as IDataObject) : { result: paid.body as string })
		: envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
	const tx = receipt?.transaction || null;
	const payment: IDataObject = {
		amount_usd: atomicToUsd(amount),
		amount_atomic: amount.toString(),
		asset: 'USDC',
		asset_address: USDC_BASE,
		network: BASE_NETWORK,
		pay_to: payee,
		payer: from,
		service_id: serviceId,
		route: direct ? 'agentsearch-x402-direct' : 'pocket',
		...(dropped.length ? { dropped_fields: dropped } : {}),
		settled: receipt?.success ?? false,
		transaction: tx,
		...(tx ? { explorer: `https://basescan.org/tx/${tx}` } : {}),
		run_spent_usd: atomicToUsd(signedAtomic),
	};
	return { json: { ...data, payment, portal: direct ? null : envelope.portal ?? null }, signedAtomic };
}
