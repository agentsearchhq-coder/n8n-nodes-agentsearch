import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

/**
 * Wallet used to pay per call for Extract ($0.007) and Render ($0.010) in USDC on Base over x402,
 * by default to AgentSearch's own x402 API (Pocket portal route optional). Free Search never uses it.
 */
export class AgentSearchWalletApi implements ICredentialType {
	name = 'agentSearchWalletApi';

	displayName = 'AgentSearch Wallet API';

	icon: Icon = { light: 'file:agentsearch.svg', dark: 'file:agentsearch.dark.svg' };

	documentationUrl = 'https://agentsearchhq.com/blog/n8n-ai-agent-read-web-pages';

	properties: INodeProperties[] = [
		{
			displayName: 'Wallet Private Key',
			name: 'privateKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'64-hex private key of a NEW wallet made only for this, funded with a little USDC on Base (for example $1 = about 100-140 calls; no ETH needed). Used only to sign small USDC payments for Extract/Render; never sent anywhere.',
		},
		{
			displayName: 'Payment Route',
			name: 'paymentRoute',
			type: 'options',
			options: [
				{ name: 'AgentSearch Direct x402 (Extract $0.007, Render $0.010)', value: 'direct', description: "Pay AgentSearch's own x402 API on Base (api.agentsearchhq.com) (default)" },
				{ name: 'Pocket Portal ($0.005 per Call)', value: 'pocket', description: 'Pay through the Pocket Network Agentic Portal instead' },
			],
			default: 'direct',
			description: 'Where Extract and Render payments go. Both are x402 USDC on Base; the node only signs for the chosen route\'s fixed payee.',
		},
		{
			displayName: 'Max Spend per Run (USD)',
			name: 'maxSpendPerRunUsd',
			type: 'number',
			typeOptions: { minValue: 0.005, numberPrecision: 3 },
			default: 1,
			description: 'Stop signing payments in one run of the node (one batch of items or one AI tool call) once this much USDC has been signed (default $1.00). Each call is capped at $0.005 on the Pocket route and $0.010 on the direct route.',
		},
	];
}
