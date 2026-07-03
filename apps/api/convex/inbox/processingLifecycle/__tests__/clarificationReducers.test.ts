import { describe, it, expect } from 'vitest';
import { LEGAL_EDGES, TERMINAL, reduce } from '../reducers';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { PendingClarification, TransitionInput } from '../types';

// Pure unit tests for the clarification-loop lifecycle edges. These import the
// reducers DIRECTLY (no convex-test harness) — the reducers are pure functions
// of (loaded message, transition input) → { patch, effects }. The DB-side
// behaviour (answerClarification, the abandoned-question cron) is covered by the
// integration suite; these lock in the pure state-graph + reducer contract for
// every new edge.

const MSG_ID = 'msg1' as Id<'inboundMessages'>;
const ACTION_ID = 'action1' as Id<'agentActions'>;

function message(overrides: Partial<Doc<'inboundMessages'>> = {}): Doc<'inboundMessages'> {
	return {
		_id: MSG_ID,
		_creationTime: 0,
		messageId: 'ext-1',
		from: 'sender@example.com',
		to: 'support@owlat.app',
		subject: 'Help',
		textBody: 'I need help',
		processingStatus: 'classifying',
		receivedAt: 0,
		...overrides,
	} as unknown as Doc<'inboundMessages'>;
}

const classification = {
	category: 'support',
	priority: 'normal',
	sentiment: 'neutral',
	intent: 'question',
	confidence: 0.8,
};

const pendingClarification: PendingClarification = {
	questions: [
		{ id: 'q1', slotType: 'order_number', text: 'What is your order number?' },
	],
	askedAt: 1000,
};

describe('clarification legal edges', () => {
	it('classifying may advance to awaiting_clarification', () => {
		expect(LEGAL_EDGES.classifying.has('awaiting_clarification')).toBe(true);
	});

	it('awaiting_clarification may resume into drafting (answer / fallback)', () => {
		expect(LEGAL_EDGES.awaiting_clarification.has('drafting')).toBe(true);
	});

	it('awaiting_clarification may be archived (dismiss)', () => {
		expect(LEGAL_EDGES.awaiting_clarification.has('archived')).toBe(true);
	});

	it('awaiting_clarification may NOT jump straight to draft_ready or approved', () => {
		expect(LEGAL_EDGES.awaiting_clarification.has('draft_ready')).toBe(false);
		expect(LEGAL_EDGES.awaiting_clarification.has('approved')).toBe(false);
	});

	it('awaiting_clarification is NOT terminal (can still fail / be reprocessed)', () => {
		expect(TERMINAL.has('awaiting_clarification')).toBe(false);
	});

	it('drafting still cannot loop back to awaiting_clarification', () => {
		expect(LEGAL_EDGES.drafting.has('awaiting_clarification')).toBe(false);
	});
});

describe('reduce: classifying → awaiting_clarification', () => {
	const input: TransitionInput = {
		to: 'awaiting_clarification',
		at: 2000,
		completedActionId: ACTION_ID,
		output: 'need info',
		pendingClarification,
		classification,
	};

	it('persists the open questions + classification and completes the action', () => {
		const result = reduce(message(), input);
		expect(result.applied).toBe('transitioned');
		expect(result.patch['processingStatus']).toBe('awaiting_clarification');
		expect(result.patch['pendingClarification']).toEqual(pendingClarification);
		expect(result.patch['classification']).toEqual(classification);
		expect(result.patch['confidenceScore']).toBe(0.8);
		// No processedAt on a waiting state.
		expect(result.patch['processedAt']).toBeUndefined();
		expect(
			result.effects.some(
				(e) => e.kind === 'complete_action' && e.actionId === ACTION_ID,
			),
		).toBe(true);
	});

	it('does NOT fire knowledge extraction (that runs on the resume into drafting)', () => {
		const result = reduce(message(), input);
		expect(result.effects.some((e) => e.kind === 'schedule_knowledge_extraction')).toBe(false);
	});
});

describe('reduce: awaiting_clarification → drafting (resume / fallback)', () => {
	it('fires knowledge extraction exactly once on the resume edge', () => {
		const result = reduce(
			message({ processingStatus: 'awaiting_clarification', classification }),
			{ to: 'drafting', at: 3000 },
		);
		expect(result.patch['processingStatus']).toBe('drafting');
		const extractions = result.effects.filter(
			(e) => e.kind === 'schedule_knowledge_extraction',
		);
		expect(extractions.length).toBe(1);
	});
});

describe('reduce: awaiting_clarification → archived (dismiss)', () => {
	it('marks the message archived with the dismiss reason', () => {
		const result = reduce(
			message({ processingStatus: 'awaiting_clarification' }),
			{ to: 'archived', at: 4000, reason: 'clarification_dismissed' },
		);
		expect(result.patch['processingStatus']).toBe('archived');
		expect(result.patch['processedAt']).toBe(4000);
	});
});
