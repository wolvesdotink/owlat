import { describe, expect, it } from 'vitest';
import {
	parsePluginId,
	PLUGIN_WEBHOOK_EVENT_CAPABILITY,
	pluginWebhookEventKind,
	validatePluginManifest,
	type PluginManifestIssue,
} from '../index';

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'events-pack',
		version: '1.0.0',
		capabilities: [PLUGIN_WEBHOOK_EVENT_CAPABILITY],
		flag: { default: false },
		contributes: {
			webhookEvents: [{ id: 'deal-won', description: 'A deal was won', subscribable: true }],
		},
		...overrides,
	};
}

function issuesFor(value: unknown): readonly PluginManifestIssue[] {
	const result = validatePluginManifest(value);
	return result.ok ? [] : result.issues;
}

describe('plugin webhook event contributions', () => {
	it('namespaces every plugin event under its owning plugin id', () => {
		expect(pluginWebhookEventKind(parsePluginId('events-pack'), 'deal-won')).toBe(
			'plugin.events-pack.deal-won'
		);
	});

	it('accepts a well-formed webhook-event manifest', () => {
		expect(validatePluginManifest(base()).ok).toBe(true);
	});

	it('requires the webhooks:publish capability when events are contributed', () => {
		const issues = issuesFor(base({ capabilities: [] }));
		expect(issues.some((issue) => issue.path === '$.capabilities')).toBe(true);
	});

	it('requires a flag when events are contributed', () => {
		const manifest = base();
		delete (manifest as { flag?: unknown }).flag;
		const issues = issuesFor(manifest);
		expect(issues.some((issue) => issue.path === '$.flag')).toBe(true);
	});

	it.each([
		[
			'bad id',
			{ id: 'Deal_Won', description: 'x', subscribable: true },
			'$.contributes.webhookEvents[0].id',
		],
		[
			'empty description',
			{ id: 'deal-won', description: '  ', subscribable: true },
			'$.contributes.webhookEvents[0].description',
		],
		[
			'non-boolean subscribable',
			{ id: 'deal-won', description: 'x', subscribable: 'yes' },
			'$.contributes.webhookEvents[0].subscribable',
		],
		[
			'unknown field',
			{ id: 'deal-won', description: 'x', subscribable: true, build: {} },
			'$.contributes.webhookEvents[0].build',
		],
	] as const)('rejects %s', (_label, event, path) => {
		const issues = issuesFor(base({ contributes: { webhookEvents: [event] } }));
		expect(issues.some((issue) => issue.path === path)).toBe(true);
	});

	it('rejects duplicate event ids', () => {
		const issues = issuesFor(
			base({
				contributes: {
					webhookEvents: [
						{ id: 'deal-won', description: 'a', subscribable: true },
						{ id: 'deal-won', description: 'b', subscribable: false },
					],
				},
			})
		);
		expect(issues.some((issue) => issue.code === 'duplicate')).toBe(true);
	});
});
