import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

/**
 * Wallet used to pay per call for Extract and Render ($0.005 in USDC on Base,
 * x402 through the Pocket Network Agentic Portal). Free Search never uses it.
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
				'64-hex private key of a NEW wallet made only for this, funded with a little USDC on Base (for example $1 = 200 calls; no ETH needed). Used only to sign $0.005 USDC payments; never sent anywhere.',
		},
		{
			displayName: 'Max Spend per Run (USD)',
			name: 'maxSpendPerRunUsd',
			type: 'number',
			typeOptions: { minValue: 0.005, numberPrecision: 3 },
			default: 1,
			description: 'Stop signing payments in one run of the node (one batch of items or one AI tool call) once this much USDC has been signed (default $1.00 = 200 calls). Each call is capped at $0.005.',
		},
	];
}
