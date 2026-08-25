/**
 * Unit tests for the generic lifecycle core (`lib/lifecycle.ts`) — edge
 * legality, self-loop classification, opt-in `terminal` refusals, the
 * sanctioned-edge escape hatch, and the module-local outcome extension.
 *
 * Pure functions; no Convex setup.
 *
 * See docs/adr/0058-generic-lifecycle-core.md.
 */

import { describe, it, expect } from 'vitest';
import {
	defineLifecycle,
	refuse,
	type LifecycleGraph,
	type LifecycleReason,
	type LifecycleRefusalReason,
	type RefusedVerdict,
} from '../lib/lifecycle';

type State = 'queued' | 'sent' | 'bounced' | 'failed';

const EDGES = {
	queued: ['sent', 'bounced', 'failed'],
	sent: ['bounced'],
	bounced: [],
	failed: [],
} as const;

const terminalAware = defineLifecycle<State>(EDGES, { reportsTerminalRefusals: true });
const terminalBlind = defineLifecycle<State>(EDGES);

describe('defineLifecycle — graph shape', () => {
	it('exposes the declared states in declaration order', () => {
		expect(terminalAware.states).toEqual(['queued', 'sent', 'bounced', 'failed']);
	});

	it('exposes the legal targets of each state as a set', () => {
		expect([...terminalAware.legalTargets('queued')].sort()).toEqual(['bounced', 'failed', 'sent']);
		expect([...terminalAware.legalTargets('sent')]).toEqual(['bounced']);
		expect(terminalAware.legalTargets('bounced').size).toBe(0);
	});

	it('does not alias the caller spec — mutating the spec array is not seen', () => {
		const spec: Record<'a' | 'b', ('a' | 'b')[]> = { a: ['b'], b: [] };
		const graph = defineLifecycle<'a' | 'b'>(spec);
		spec.a.push('a');
		expect(graph.isLegalEdge('a', 'a')).toBe(false);
	});
});

describe('defineLifecycle — edge legality', () => {
	it('accepts every declared edge', () => {
		expect(terminalAware.isLegalEdge('queued', 'sent')).toBe(true);
		expect(terminalAware.isLegalEdge('queued', 'bounced')).toBe(true);
		expect(terminalAware.isLegalEdge('queued', 'failed')).toBe(true);
		expect(terminalAware.isLegalEdge('sent', 'bounced')).toBe(true);
	});

	it('rejects undeclared edges', () => {
		expect(terminalAware.isLegalEdge('sent', 'failed')).toBe(false);
		expect(terminalAware.isLegalEdge('bounced', 'sent')).toBe(false);
	});

	it('classifies a legal edge as proceed, not a self-loop', () => {
		expect(terminalAware.classify('queued', 'sent')).toEqual({
			kind: 'proceed',
			from: 'queued',
			to: 'sent',
			isSelfLoop: false,
		});
	});

	it('classifies an illegal, non-self, non-terminal edge as illegal_edge', () => {
		expect(terminalAware.classify('sent', 'failed')).toEqual({
			kind: 'refused',
			reason: 'illegal_edge',
			from: 'sent',
			to: 'failed',
		});
	});

	it('refuses an undeclared from-state as illegal_edge rather than throwing', () => {
		const verdict = terminalAware.classify('unknown' as State, 'sent');
		expect(verdict).toEqual({
			kind: 'refused',
			reason: 'illegal_edge',
			from: 'unknown',
			to: 'sent',
		});
		expect(terminalAware.isTerminal('unknown' as State)).toBe(false);
	});
});

describe('defineLifecycle — self-loops', () => {
	it('lets an undeclared self-loop proceed and flags it', () => {
		expect(terminalAware.classify('queued', 'queued')).toEqual({
			kind: 'proceed',
			from: 'queued',
			to: 'queued',
			isSelfLoop: true,
		});
		expect(terminalAware.isLegalEdge('queued', 'queued')).toBe(false);
	});

	it('lets a self-loop out of a terminal state proceed — self-loop beats terminal', () => {
		expect(terminalAware.classify('bounced', 'bounced')).toEqual({
			kind: 'proceed',
			from: 'bounced',
			to: 'bounced',
			isSelfLoop: true,
		});
	});

	it('flags a declared self-edge as a self-loop too', () => {
		const graph = defineLifecycle<'a' | 'b'>({ a: ['a', 'b'], b: [] });
		expect(graph.classify('a', 'a')).toEqual({
			kind: 'proceed',
			from: 'a',
			to: 'a',
			isSelfLoop: true,
		});
	});
});

describe('defineLifecycle — terminal classification is opt-in', () => {
	it('reports states with no outgoing edges as terminal', () => {
		expect(terminalAware.isTerminal('bounced')).toBe(true);
		expect(terminalAware.isTerminal('failed')).toBe(true);
		expect(terminalAware.isTerminal('queued')).toBe(false);
		expect(terminalAware.isTerminal('sent')).toBe(false);
	});

	it('refuses out of a terminal state with reason terminal when opted in', () => {
		expect(terminalAware.reportsTerminalRefusals).toBe(true);
		expect(terminalAware.classify('bounced', 'sent')).toEqual({
			kind: 'refused',
			reason: 'terminal',
			from: 'bounced',
			to: 'sent',
		});
	});

	it('refuses the same edge as illegal_edge by default', () => {
		expect(terminalBlind.reportsTerminalRefusals).toBe(false);
		expect(terminalBlind.classify('bounced', 'sent')).toEqual({
			kind: 'refused',
			reason: 'illegal_edge',
			from: 'bounced',
			to: 'sent',
		});
		// The terminal *shape* is still queryable — only the reason is withheld.
		expect(terminalBlind.isTerminal('bounced')).toBe(true);
	});

	it('never reports terminal for a non-terminal illegal edge', () => {
		expect(terminalAware.classify('sent', 'failed')).toMatchObject({
			reason: 'illegal_edge',
		});
	});
});

describe('defineLifecycle — sanctioned-edge escape hatch', () => {
	const doi = defineLifecycle<'not_required' | 'pending' | 'confirmed'>(
		{
			not_required: ['pending'],
			pending: ['confirmed'],
			confirmed: [],
		},
		{ reportsTerminalRefusals: true }
	);

	it('refuses the undeclared edge without the sanction', () => {
		expect(doi.classify('not_required', 'confirmed')).toMatchObject({
			kind: 'refused',
			reason: 'illegal_edge',
		});
	});

	it('lets the module sanction the edge for one call', () => {
		expect(doi.classify('not_required', 'confirmed', { isSanctionedEdge: true })).toEqual({
			kind: 'proceed',
			from: 'not_required',
			to: 'confirmed',
			isSelfLoop: false,
		});
	});

	it('does not persist the sanction into the graph', () => {
		doi.classify('not_required', 'confirmed', { isSanctionedEdge: true });
		expect(doi.isLegalEdge('not_required', 'confirmed')).toBe(false);
	});
});

describe('refuse — outcome scaffolding', () => {
	const refused = terminalAware.classify('bounced', 'sent') as RefusedVerdict<State>;

	it('builds the shared refusal shape', () => {
		expect(refuse(refused)).toEqual({
			ok: false,
			reason: 'terminal',
			from: 'bounced',
			to: 'sent',
		});
	});

	it('folds module-local context into the refusal', () => {
		expect(refuse(refused, { mailMessageId: 'msg_1', recipientIdx: 3 })).toEqual({
			ok: false,
			reason: 'terminal',
			from: 'bounced',
			to: 'sent',
			mailMessageId: 'msg_1',
			recipientIdx: 3,
		});
	});
});

/**
 * The refusal reason `refuse()` hands back is typed by the graph that produced
 * the verdict, so the six machines that never report `terminal` can call it
 * without widening their published outcome unions.
 *
 * These are compile-level assertions as much as runtime ones: this file sits
 * inside `convex/tsconfig.json`, so every annotated binding below is checked by
 * `tsc --noEmit`, and each `@ts-expect-error` is itself the assertion —
 * TypeScript reports an UNUSED `@ts-expect-error` as an error of its own, so a
 * regression that widened (or over-narrowed) the reason fails the typecheck.
 */
describe('refuse — the reason type follows the graph', () => {
	it('types a refusal from a terminal-blind graph as illegal_edge alone', () => {
		const verdict = terminalBlind.classify('bounced', 'sent');
		expect(verdict.kind).toBe('refused');
		if (verdict.kind !== 'refused') throw new Error('expected a refusal');

		const reason: 'illegal_edge' = verdict.reason;
		const outcome: { ok: false; reason: 'illegal_edge' } = refuse(verdict);

		expect(reason).toBe('illegal_edge');
		expect(outcome).toEqual({ ok: false, reason: 'illegal_edge', from: 'bounced', to: 'sent' });
	});

	it('excludes terminal from a terminal-blind refusal', () => {
		const verdict = terminalBlind.classify('bounced', 'sent') as RefusedVerdict<
			State,
			State,
			'illegal_edge'
		>;
		// @ts-expect-error — no `terminal` member: this is what lets a machine
		// publishing only `illegal_edge` return `refuse(verdict)` unchanged.
		const widened: 'terminal' = refuse(verdict).reason;
		expect(widened).toBe('illegal_edge');
	});

	it('keeps both reasons for a terminal-reporting graph', () => {
		const verdict = terminalAware.classify('bounced', 'sent');
		if (verdict.kind !== 'refused') throw new Error('expected a refusal');

		const reason: LifecycleRefusalReason = verdict.reason;
		// @ts-expect-error — opting in keeps `terminal` in the union, so the
		// narrowing must not leak onto graphs that do report it.
		const narrowed: 'illegal_edge' = refuse(verdict).reason;

		expect(reason).toBe('terminal');
		expect(narrowed).toBe('terminal');
	});

	it('folds context into a narrowed refusal too', () => {
		const verdict = terminalBlind.classify('bounced', 'sent') as RefusedVerdict<
			State,
			State,
			'illegal_edge'
		>;
		const outcome: { ok: false; reason: 'illegal_edge'; draftId: string } = refuse(verdict, {
			draftId: 'draft_1',
		});
		expect(outcome).toEqual({
			ok: false,
			reason: 'illegal_edge',
			from: 'bounced',
			to: 'sent',
			draftId: 'draft_1',
		});
	});

	it('defaults a bare LifecycleGraph annotation to the full reason union', () => {
		// `delivery/sendLifecycle` annotates `lifecycleFor(): LifecycleGraph<SendStatus>`
		// and returns terminal-reporting graphs from it, so the third parameter
		// has to default wide for that annotation to stay truthful.
		const graph: LifecycleGraph<State> = terminalAware;
		expect(graph.reportsTerminalRefusals).toBe(true);
	});

	it('rejects a terminal flag it cannot read as a literal', () => {
		const readFlagFromConfig = (): boolean => true;
		const options = { reportsTerminalRefusals: readFlagFromConfig() };
		// @ts-expect-error — the flag must be a literal at the call site: from a
		// plain `boolean` the core cannot tell which reason set the graph
		// produces, so neither overload matches rather than one guessing.
		const graph = defineLifecycle<State>(EDGES, options);
		expect(graph.reportsTerminalRefusals).toBe(true);
	});
});

describe('LifecycleReason — module-local outcome extension', () => {
	type ModuleReason = LifecycleReason<'unknown_mta_id_prefix' | 'recipient_not_found'>;

	it('admits both the core reasons and the module literals', () => {
		const reasons: ModuleReason[] = [
			'illegal_edge',
			'terminal',
			'unknown_mta_id_prefix',
			'recipient_not_found',
		];
		expect(reasons).toHaveLength(4);
	});

	it('accepts a core refusal reason without narrowing', () => {
		const outcome: { ok: false; reason: ModuleReason } = refuse(
			terminalAware.classify('sent', 'failed') as RefusedVerdict<State>
		);
		expect(outcome.reason).toBe('illegal_edge');
	});
});
