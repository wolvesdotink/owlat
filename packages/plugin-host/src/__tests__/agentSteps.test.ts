import { describe, expect, it } from 'vitest';
import { parsePluginId } from '@owlat/plugin-kit';
import { AgentStepCompositionError, composeAgentStepDefinitions } from '../agentSteps';

const pluginId = parsePluginId('policy-pack');
const definition = (kind: string, after: string, from = 'classifying', to = 'archived') => ({
	pluginId,
	packageName: 'policy-pack',
	kind,
	after,
	exportPath: './agent/step',
	lifecycleEdges: [{ from, to }],
});

describe('hosted agent step composition', () => {
	it('resolves chained steps deterministically and inherits the core continuation status', () => {
		const first = definition('plugin.policy-pack.first', 'security_scan');
		const second = definition('plugin.policy-pack.second', first.kind);
		expect(composeAgentStepDefinitions([second, first])).toEqual([
			expect.objectContaining({ kind: first.kind, continuationStatus: 'classifying' }),
			expect.objectContaining({ kind: second.kind, continuationStatus: 'classifying' }),
		]);
	});

	it.each([
		[
			'duplicate_step_kind',
			[
				definition('plugin.policy-pack.same', 'security_scan'),
				definition('plugin.policy-pack.same', 'classify'),
			],
		],
		['unknown_step_anchor', [definition('plugin.policy-pack.step', 'missing')]],
		[
			'cyclic_step_order',
			[
				definition('plugin.policy-pack.first', 'plugin.policy-pack.second'),
				definition('plugin.policy-pack.second', 'plugin.policy-pack.first'),
			],
		],
		['terminal_step_anchor', [definition('plugin.policy-pack.step', 'route')]],
		[
			'unsafe_lifecycle_edge',
			[definition('plugin.policy-pack.step', 'security_scan', 'classifying', 'approved')],
		],
		[
			'unsafe_lifecycle_edge',
			[definition('plugin.policy-pack.step', 'security_scan', 'drafting', 'draft_ready')],
		],
	] as const)('rejects %s', (code, definitions) => {
		expect(() => composeAgentStepDefinitions(definitions)).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({ code })
		);
	});

	it('allows a drafting plugin to force human review but never approval or send', () => {
		expect(
			composeAgentStepDefinitions([
				definition('plugin.policy-pack.review', 'draft', 'drafting', 'draft_ready'),
			])
		).toEqual([
			expect.objectContaining({
				kind: 'plugin.policy-pack.review',
				continuationStatus: 'drafting',
			}),
		]);
	});
});
