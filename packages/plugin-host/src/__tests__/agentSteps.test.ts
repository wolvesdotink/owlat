import { describe, expect, it } from 'vitest';
import { parsePluginId, type PluginAgentLifecycleEdge } from '@owlat/plugin-kit';
import { AgentStepCompositionError, composeAgentStepDefinitions } from '../agentSteps';

const pluginId = parsePluginId('policy-pack');
const classificationCaution: PluginAgentLifecycleEdge = {
	kind: 'caution',
	from: 'classifying',
	to: 'archived',
};
const uncheckedLifecycleEdge = (value: unknown): PluginAgentLifecycleEdge =>
	value as PluginAgentLifecycleEdge;
const definition = (
	kind: string,
	after: string,
	edge: PluginAgentLifecycleEdge = classificationCaution
) => ({
	pluginId,
	packageName: 'policy-pack',
	kind,
	after,
	exportPath: './agent/step',
	lifecycleEdges: [edge],
});

describe('hosted agent step composition', () => {
	it('resolves chained steps deterministically and inherits core placement', () => {
		const first = definition('plugin.policy-pack.first', 'security_scan');
		const second = definition('plugin.policy-pack.second', first.kind);
		expect(composeAgentStepDefinitions([second, first])).toEqual([
			expect.objectContaining({
				kind: first.kind,
				continuationStatus: 'classifying',
				placement: 'classification',
			}),
			expect.objectContaining({
				kind: second.kind,
				continuationStatus: 'classifying',
				placement: 'classification',
			}),
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
			[
				definition('plugin.policy-pack.step', 'security_scan', {
					kind: 'draft_review',
					from: 'drafting',
					to: 'draft_ready',
				}),
			],
		],
		[
			'unsafe_lifecycle_edge',
			[
				definition('plugin.policy-pack.step', 'clarify', {
					kind: 'draft_review',
					from: 'drafting',
					to: 'draft_ready',
				}),
			],
		],
	] as const)('rejects %s', (code, definitions) => {
		expect(() => composeAgentStepDefinitions(definitions)).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({ code })
		);
	});

	it('allows draft review only in the post-draft subtree', () => {
		expect(
			composeAgentStepDefinitions([
				definition('plugin.policy-pack.review', 'draft', {
					kind: 'draft_review',
					from: 'drafting',
					to: 'draft_ready',
				}),
			])
		).toEqual([
			expect.objectContaining({
				kind: 'plugin.policy-pack.review',
				continuationStatus: 'drafting',
				placement: 'after_draft',
			}),
		]);
	});

	it('rejects draft review from every descendant of a pre-draft step', () => {
		const parent = definition('plugin.policy-pack.parent', 'clarify', {
			kind: 'caution',
			from: 'drafting',
			to: 'failed',
		});
		const child = definition('plugin.policy-pack.child', parent.kind, {
			kind: 'draft_review',
			from: 'drafting',
			to: 'draft_ready',
		});
		expect(() => composeAgentStepDefinitions([child, parent])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'unsafe_lifecycle_edge',
				stepKind: child.kind,
			})
		);
	});

	it.each([
		['classification', 'security_scan', { kind: 'caution', from: 'classifying', to: 'sent' }],
		['classification', 'classify', { kind: 'caution', from: 'classifying', to: 'approved' }],
		['classification', 'security_scan', { kind: 'caution', from: 'classifying', to: 'unknown' }],
		['classification', 'classify', { kind: 'caution', from: 'drafting', to: 'archived' }],
		['classification', 'classify', { kind: 'draft_review', from: 'classifying', to: 'archived' }],
		['before-draft', 'clarify', { kind: 'caution', from: 'drafting', to: 'sent' }],
		['before-draft', 'clarify', { kind: 'caution', from: 'drafting', to: 'approved' }],
		['before-draft', 'clarify', { kind: 'caution', from: 'drafting', to: 'unknown' }],
		['before-draft', 'clarify', { kind: 'caution', from: 'classifying', to: 'archived' }],
		['before-draft', 'clarify', { kind: 'draft_review', from: 'drafting', to: 'draft_ready' }],
		['post-draft', 'draft', { kind: 'caution', from: 'drafting', to: 'sent' }],
		['post-draft', 'draft', { kind: 'caution', from: 'drafting', to: 'approved' }],
		['post-draft', 'draft', { kind: 'caution', from: 'drafting', to: 'unknown' }],
		['post-draft', 'draft', { kind: 'caution', from: 'classifying', to: 'archived' }],
		['post-draft', 'draft', { kind: 'draft_review', from: 'classifying', to: 'draft_ready' }],
		['post-draft', 'draft', { kind: 'draft_review', from: 'drafting', to: 'archived' }],
		['post-draft', 'draft', { kind: 'unknown', from: 'drafting', to: 'archived' }],
	] as const)('rejects an unchecked %s lifecycle tuple after %s', (_placement, after, edge) => {
		const step = definition('plugin.policy-pack.unchecked', after, uncheckedLifecycleEdge(edge));
		expect(() => composeAgentStepDefinitions([step])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'unsafe_lifecycle_edge',
				stepKind: step.kind,
			})
		);
	});

	it.each([
		null,
		'caution',
		{},
		{ kind: 'caution', from: 'drafting' },
		Object.defineProperty({}, 'kind', { enumerable: true, get: () => 'caution' }),
	])('rejects a malformed unchecked lifecycle edge %#', (edge) => {
		const step = definition('plugin.policy-pack.malformed', 'draft', uncheckedLifecycleEdge(edge));
		expect(() => composeAgentStepDefinitions([step])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'unsafe_lifecycle_edge',
				stepKind: step.kind,
			})
		);
	});
});
