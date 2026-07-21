import { describe, expect, it } from 'vitest';
import { parsePluginId, type PluginAgentLifecycleEdge } from '@owlat/plugin-kit';
import {
	AgentStepCompositionError,
	CORE_AGENT_STEP_DEFINITIONS,
	composeAgentStepDefinitions,
} from '../agentSteps';

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
	it('deeply freezes the host-owned core pipeline policy', () => {
		expect(Object.isFrozen(CORE_AGENT_STEP_DEFINITIONS)).toBe(true);
		expect(CORE_AGENT_STEP_DEFINITIONS.every((entry) => Object.isFrozen(entry))).toBe(true);
		const route = CORE_AGENT_STEP_DEFINITIONS.find((entry) => entry.kind === 'route');
		if (!route) throw new Error('Expected the core route step');
		expect(Reflect.set(route, 'continuationStatus', 'drafting')).toBe(false);
		expect(Reflect.set(route, 'placement', 'after_draft')).toBe(false);

		expect(() =>
			composeAgentStepDefinitions([
				definition('plugin.policy-pack.after-route', 'route', {
					kind: 'draft_review',
					from: 'drafting',
					to: 'draft_ready',
				}),
			])
		).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'terminal_step_anchor',
			})
		);
	});

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

	it('owns and deeply freezes lifecycle snapshots after composition', () => {
		const step = definition('plugin.policy-pack.owned', 'security_scan', {
			kind: 'caution',
			from: 'classifying',
			to: 'archived',
		});
		const originalEdges = step.lifecycleEdges;
		const originalEdge = originalEdges[0] as { kind: string; from: string; to: string };
		let unrelatedReads = 0;
		Object.defineProperty(step, 'unrelated', {
			enumerable: true,
			get: () => {
				unrelatedReads += 1;
				return { callerOwned: true };
			},
		});

		const [composed] = composeAgentStepDefinitions([step]);
		if (!composed) throw new Error('Expected the hosted agent step to be composed');
		originalEdge.to = 'sent';
		originalEdges.push(
			uncheckedLifecycleEdge({ kind: 'caution', from: 'classifying', to: 'failed' })
		);

		expect(composed.lifecycleEdges).toEqual([
			{ kind: 'caution', from: 'classifying', to: 'archived' },
		]);
		expect(composed.lifecycleEdges).not.toBe(originalEdges);
		expect(composed.lifecycleEdges[0]).not.toBe(originalEdge);
		expect(Object.isFrozen(composed)).toBe(true);
		expect(Object.isFrozen(composed.lifecycleEdges)).toBe(true);
		expect(Object.isFrozen(composed.lifecycleEdges[0])).toBe(true);
		expect(unrelatedReads).toBe(0);
		expect(composed).not.toHaveProperty('unrelated');
	});

	it('rejects an accessor lifecycle collection without invoking it', () => {
		const step = definition('plugin.policy-pack.accessor-edges', 'security_scan');
		let reads = 0;
		Object.defineProperty(step, 'lifecycleEdges', {
			enumerable: true,
			get: () => {
				reads += 1;
				return [classificationCaution];
			},
		});

		expect(() => composeAgentStepDefinitions([step])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'unsafe_lifecycle_edge',
				stepKind: step.kind,
			})
		);
		expect(reads).toBe(0);
	});

	it('rejects accessor-backed definition fields and array entries without invoking them', () => {
		const accessorKind = definition('plugin.policy-pack.accessor-kind', 'security_scan');
		let kindReads = 0;
		Object.defineProperty(accessorKind, 'kind', {
			enumerable: true,
			get: () => {
				kindReads += 1;
				return 'plugin.policy-pack.accessor-kind';
			},
		});
		expect(() => composeAgentStepDefinitions([accessorKind])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'invalid_step_definition',
			})
		);
		expect(kindReads).toBe(0);

		const accessorEdge = definition('plugin.policy-pack.accessor-edge', 'security_scan');
		let iteratorReads = 0;
		let edgeReads = 0;
		Object.defineProperty(accessorEdge.lifecycleEdges, Symbol.iterator, {
			get: () => {
				iteratorReads += 1;
				return Array.prototype[Symbol.iterator];
			},
		});
		Object.defineProperty(accessorEdge.lifecycleEdges, '0', {
			get: () => {
				edgeReads += 1;
				return classificationCaution;
			},
		});
		expect(() => composeAgentStepDefinitions([accessorEdge])).toThrowError(
			expect.objectContaining<Partial<AgentStepCompositionError>>({
				code: 'unsafe_lifecycle_edge',
			})
		);
		expect(iteratorReads).toBe(0);
		expect(edgeReads).toBe(0);
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
