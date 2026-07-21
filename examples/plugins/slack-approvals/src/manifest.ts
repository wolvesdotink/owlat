/**
 * The plugin manifest an operator adds to `plugins.config.ts` to allow BINDING
 * this connected app on the PP-22 domain. The manifest is the app's declarative
 * identity: it declares the single capability the app can ever exercise —
 * `send:gate` (the autonomy send gate) — and nothing else. Because a connected
 * app can request only a subset of what its bound plugin declares, and the
 * operator grant is re-checked at every hook, this manifest is the restrict-only
 * ceiling: this app can hold a send for review, and it can do nothing else.
 *
 * There are deliberately NO in-process contributions here (no `contributes`
 * block): the gate runs out-of-process, over the signed hook, and re-enters
 * Owlat only as a restrict-only verdict. The `settingsSchema` is the operator's
 * knobs — the Slack signing secret plus the channel, quorum, and window — all
 * stored server-side (the secret is a `secret` field, never returned to a
 * browser).
 */

import { definePlugin, PLUGIN_AUTONOMY_GATE_CAPABILITY } from '@owlat/plugin-kit';

export const SLACK_APPROVALS_PLUGIN_ID = 'slack-approvals';

export const slackApprovalsPlugin = definePlugin({
	id: SLACK_APPROVALS_PLUGIN_ID,
	version: '0.1.0',
	capabilities: [PLUGIN_AUTONOMY_GATE_CAPABILITY],
	flag: {
		default: false,
	},
	settingsSchema: [
		{
			kind: 'secret',
			key: 'slackSigningSecret',
			envVar: 'PLUGIN_SLACK_SIGNING_SECRET',
			label: 'Slack signing secret',
			description:
				'Used by this connected app to authenticate Slack interaction callbacks. Owlat stores no value: it reports only whether the deployment sets the variable.',
			required: true,
		},
		{
			kind: 'secret',
			key: 'slackBotToken',
			envVar: 'PLUGIN_SLACK_BOT_TOKEN',
			label: 'Slack bot token',
			description:
				'Used to post the approval request into the channel. Owlat stores no value: it reports only whether the deployment sets the variable.',
			required: true,
		},
		{
			kind: 'string',
			key: 'slackChannel',
			label: 'Approval channel',
			description: 'Channel id the approval request is posted to.',
			required: true,
			maxLength: 64,
		},
		{
			kind: 'number',
			key: 'requiredApprovals',
			label: 'Required approvals (quorum)',
			description: 'How many distinct approvals clear the hold.',
			default: 1,
			min: 1,
			max: 20,
		},
		{
			kind: 'number',
			key: 'ttlMinutes',
			label: 'Approval window (minutes)',
			description: 'How long the request stays open before it expires and keeps holding.',
			default: 60,
			min: 1,
			max: 1440,
		},
	],
});
