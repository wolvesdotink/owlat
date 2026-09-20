import { describe, it, expect } from 'vitest';
import { PROCESSING_LIFECYCLE, reduce } from '../reducers';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { TransitionInput } from '../types';

// Pure unit tests for the `informational` state (ADR-0061) and the
// clarification notice effect. The reducers are pure functions of (loaded
// message, transition input) → { patch, effects }; the effect runner and the
// dashboard mutations are covered elsewhere.

const MSG_ID = 'msg1' as Id<'inboundMessages'>;
const ACTION_ID = 'action1' as Id<'agentActions'>;

function message(overrides: Partial<Doc<'inboundMessages'>> = {}): Doc<'inboundMessages'> {
	return {
		_id: MSG_ID,
		_creationTime: 0,
		messageId: 'ext-1',
		from: 'sender@example.com',
		to: 'support@owlat.app',
		subject: 'Delivery moved to Friday',
		textBody: 'FYI the delivery is now Friday.',
		processingStatus: 'classifying',
		receivedAt: 0,
		...overrides,
	} as unknown as Doc<'inboundMessages'>;
}

const classification = {
	category: 'other',
	priority: 'normal',
	sentiment: 'neutral',
	intent: 'information',
	confidence: 0.9,
	needsResponse: false,
	language: 'en',
	importance: 0.7,
	summary: { en: 'Delivery moved to Friday.', de: 'Lieferung auf Freitag verschoben.' },
};

describe('informational legal edges', () => {
	it('classifying may park as informational', () => {
		expect(PROCESSING_LIFECYCLE.isLegalEdge('classifying', 'informational')).toBe(true);
	});

	it('informational may be overruled into drafting or dismissed into archived', () => {
		expect(PROCESSING_LIFECYCLE.isLegalEdge('informational', 'drafting')).toBe(true);
		expect(PROCESSING_LIFECYCLE.isLegalEdge('informational', 'archived')).toBe(true);
	});

	it('informational may NOT jump to draft_ready, approved or awaiting_clarification', () => {
		expect(PROCESSING_LIFECYCLE.isLegalEdge('informational', 'draft_ready')).toBe(false);
		expect(PROCESSING_LIFECYCLE.isLegalEdge('informational', 'approved')).toBe(false);
		expect(PROCESSING_LIFECYCLE.isLegalEdge('informational', 'awaiting_clarification')).toBe(false);
	});

	it('informational is not terminal (a reader can still ask for a draft)', () => {
		expect(PROCESSING_LIFECYCLE.isTerminal('informational')).toBe(false);
	});
});

describe('reduce: classifying → informational', () => {
	const input: TransitionInput = {
		to: 'informational',
		at: 2000,
		completedActionId: ACTION_ID,
		output: 'no reply needed',
		classification,
	};

	it('persists the classification (summaries, language, importance) and stamps processedAt', () => {
		const result = reduce(message(), input);
		expect(result.patch['processingStatus']).toBe('informational');
		expect(result.patch['classification']).toEqual(classification);
		expect(result.patch['confidenceScore']).toBe(0.9);
		expect(result.patch['processedAt']).toBe(2000);
		expect(
			result.effects.some((e) => e.kind === 'complete_action' && e.actionId === ACTION_ID)
		).toBe(true);
	});

	it('mines the update for knowledge exactly like the drafting edge', () => {
		const result = reduce(message(), input);
		expect(result.effects.filter((e) => e.kind === 'schedule_knowledge_extraction')).toHaveLength(
			1
		);
	});
});

describe('reduce: informational → drafting (reader overrule)', () => {
	it('does not extract knowledge a second time', () => {
		const result = reduce(message({ processingStatus: 'informational', classification }), {
			to: 'drafting',
			at: 3000,
		});
		expect(result.patch['processingStatus']).toBe('drafting');
		expect(result.effects.some((e) => e.kind === 'schedule_knowledge_extraction')).toBe(false);
	});
});

describe('reduce: informational → archived (dismiss)', () => {
	it('archives with the update_dismissed reason', () => {
		const result = reduce(message({ processingStatus: 'informational' }), {
			to: 'archived',
			at: 4000,
			reason: 'update_dismissed',
		});
		expect(result.patch['processingStatus']).toBe('archived');
		expect(result.patch['processedAt']).toBe(4000);
	});
});

describe('reduce: classifying → awaiting_clarification notifies the responsible person', () => {
	it('emits exactly one notify_clarification effect for the parked message', () => {
		const result = reduce(message(), {
			to: 'awaiting_clarification',
			at: 5000,
			pendingClarification: {
				questions: [{ id: 'q0', slotType: 'decision', text: 'Grant terms?' }],
				askedAt: 5000,
			},
			classification,
		});
		const notices = result.effects.filter((e) => e.kind === 'notify_clarification');
		expect(notices).toEqual([{ kind: 'notify_clarification', inboundMessageId: MSG_ID }]);
	});
});
