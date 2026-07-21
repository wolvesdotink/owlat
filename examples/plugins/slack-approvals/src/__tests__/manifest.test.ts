import { describe, expect, it } from 'vitest';
import { isPluginManifest, PLUGIN_AUTONOMY_GATE_CAPABILITY } from '@owlat/plugin-kit';
import { SLACK_APPROVALS_PLUGIN_ID, slackApprovalsPlugin } from '../manifest';

describe('slackApprovalsPlugin manifest', () => {
	it('is a valid plugin manifest', () => {
		expect(isPluginManifest(slackApprovalsPlugin)).toBe(true);
		expect(slackApprovalsPlugin.id).toBe(SLACK_APPROVALS_PLUGIN_ID);
	});

	it('declares the send-gate capability and nothing beyond it (restrict-only ceiling)', () => {
		expect(slackApprovalsPlugin.capabilities).toEqual([PLUGIN_AUTONOMY_GATE_CAPABILITY]);
	});

	it('ships no in-process contributions (the gate runs out-of-process over the hook)', () => {
		expect(slackApprovalsPlugin.contributes).toBeUndefined();
	});

	it('is disabled by default so binding is an explicit operator action', () => {
		expect(slackApprovalsPlugin.flag?.default).toBe(false);
	});

	it('exposes the Slack signing secret as a redacted secret field', () => {
		const signingSecret = slackApprovalsPlugin.settingsSchema?.find(
			(field) => field.key === 'slackSigningSecret'
		);
		expect(signingSecret?.kind).toBe('secret');
	});
});
