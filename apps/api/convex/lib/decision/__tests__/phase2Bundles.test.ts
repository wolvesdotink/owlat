/**
 * The Phase 2 mail bundles (ADR-0073): the per-surface field mappings, the
 * bundle rendering, the label projection and the evidence state. Pure.
 */

import { describe, expect, it } from 'vitest';
import { segmentMessage } from '@owlat/shared/mailSegments';
import { classificationSchema } from '../../../agent/steps/classify';
import { categoryRefinementSchema } from '../../../mail/ai/categoryClassify';
import { updateRankScore } from '../../../inbox/updates';
import {
	isRegisteredQuestionSet,
	POSTBOX_MESSAGE_QUESTIONS,
	TEAM_MESSAGE_QUESTIONS,
} from '../catalog';
import {
	agreementWith,
	CHOICE_THRESHOLD,
	choiceLabel,
	DISPOSITION_THRESHOLD,
	interpretDisposition,
	isAbstention,
	POSTBOX_MESSAGE_BUNDLE,
	TEAM_MESSAGE_BUNDLE,
	TRIAGE_BUNDLE,
} from '../bundles';
import {
	DECISION_LANGUAGE_DOMAIN,
	IMPORTANCE_LOOKUP,
	POSTBOX_FIELD_MAPPINGS,
	TEAM_FIELD_MAPPINGS,
	UNKNOWN_LABEL,
	type FieldMapping,
} from '../fieldMappings';
import {
	decisionMessageState,
	evidenceBody,
	evidenceSegments,
	STATE_BODY_CHARS,
	stateContentHash,
	type DecisionEvidence,
} from '../evidence';
import { choice } from '../questions';
import type { ChoiceAnswer } from '../questions';
import {
	mapAnswers,
	renderDecisionPrompt,
	renderDecisionSchema,
} from '../../decisionProviders/llm';

const choiceAnswer = (value: string, confidence: number): ChoiceAnswer => ({
	kind: 'choice',
	value,
	probabilities: { [value]: confidence },
	confidence,
});

const BUNDLES = [TRIAGE_BUNDLE, TEAM_MESSAGE_BUNDLE, POSTBOX_MESSAGE_BUNDLE] as const;

describe('per-surface field mappings', () => {
	it('maps every Team classifier field, and nothing else', () => {
		expect(Object.keys(TEAM_FIELD_MAPPINGS).sort()).toEqual(
			Object.keys(classificationSchema.shape).sort()
		);
	});

	it('gives every Team enum field its exact Choice domain plus unknown', () => {
		const shape = classificationSchema.shape;
		for (const field of ['category', 'priority', 'sentiment', 'intent', 'kind'] as const) {
			const mapping = TEAM_FIELD_MAPPINGS[field];
			expect(mapping.executor).toBe('choice');
			expect(mapping.domain).toEqual([...shape[field].options, UNKNOWN_LABEL]);
		}
	});

	it('keeps the Postbox categories apart from the Team ones', () => {
		expect(POSTBOX_FIELD_MAPPINGS.category.domain).toEqual([
			...categoryRefinementSchema.shape.category.options,
			UNKNOWN_LABEL,
		]);
		expect(POSTBOX_FIELD_MAPPINGS.category.domain).not.toEqual(TEAM_FIELD_MAPPINGS.category.domain);
	});

	it('asks exactly the mapped domain where a bundle asks a field', () => {
		const asked: [FieldMapping, Record<string, { criteria?: unknown }>][] = [
			[TEAM_FIELD_MAPPINGS.category, TEAM_MESSAGE_QUESTIONS],
			[TEAM_FIELD_MAPPINGS.needsResponse, TEAM_MESSAGE_QUESTIONS],
			[POSTBOX_FIELD_MAPPINGS.category, POSTBOX_MESSAGE_QUESTIONS],
			[POSTBOX_FIELD_MAPPINGS.needsReply, POSTBOX_MESSAGE_QUESTIONS],
		];
		for (const [mapping, questions] of asked) {
			if (mapping.executor !== 'choice' && mapping.executor !== 'noul') throw new Error('asked');
			const key = mapping.askedBy?.key;
			expect(key && questions[key]).toBeTruthy();
			if (mapping.executor === 'choice') {
				const options = Object.keys((questions[key!] as { criteria: object }).criteria);
				expect([...options, UNKNOWN_LABEL]).toEqual(mapping.domain);
			}
		}
	});

	it('names the probability every asked threshold reads', () => {
		for (const mapping of [
			...Object.values(TEAM_FIELD_MAPPINGS),
			...Object.values(POSTBOX_FIELD_MAPPINGS),
		] as FieldMapping[]) {
			if (mapping.executor === 'choice') expect(mapping.reads).toBe('choice_peakedness');
			if (mapping.executor === 'noul') expect(mapping.reads).toBe('noul_probability');
		}
		expect(CHOICE_THRESHOLD.reads).toBe('choice_peakedness');
		expect(DISPOSITION_THRESHOLD.reads).toBe('noul_probability');
	});

	it('builds every Choice domain as a valid question', () => {
		for (const mapping of Object.values(TEAM_FIELD_MAPPINGS) as FieldMapping[]) {
			if (mapping.executor !== 'choice') continue;
			const criteria = Object.fromEntries(mapping.domain.map((label) => [label, null]));
			expect(() => choice('Classify.', criteria)).not.toThrow();
		}
	});

	it('reviews the language codes and falls back to the classifier', () => {
		expect(DECISION_LANGUAGE_DOMAIN).toEqual(['en', 'de', 'other', UNKNOWN_LABEL]);
		expect(TEAM_FIELD_MAPPINGS.language.hostRule).toMatch(/sanitized classifier code/);
	});

	it('defines the numeric confidence consumers instead of mapping a number', () => {
		expect(TEAM_FIELD_MAPPINGS.confidence.executor).toBe('host');
		expect(TEAM_FIELD_MAPPINGS.confidence.consumers).toContain(
			'agent/steps/classify INFORMATIONAL_MIN_CONFIDENCE'
		);
	});

	it('maps importance as an ordinal Score through a lookup its consumer keeps in order', () => {
		const importance = TEAM_FIELD_MAPPINGS.importance;
		expect(importance.executor).toBe('score');
		expect(importance.levels).toHaveLength(IMPORTANCE_LOOKUP.values.length);
		// Checked against `updateRankScore`: one level more important outranks
		// any priority bonus of the level below.
		const rank = (level: number, priority: string) =>
			updateRankScore({
				receivedAt: 0,
				classification: { importance: IMPORTANCE_LOOKUP.values[level], priority },
			});
		for (let level = 1; level < IMPORTANCE_LOOKUP.values.length; level++) {
			expect(rank(level, 'low')).toBeGreaterThan(rank(level - 1, 'urgent'));
		}
		for (const value of IMPORTANCE_LOOKUP.values) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});
});

describe('the Phase 2 bundles', () => {
	it('are registered catalog sets, each with its own id', () => {
		for (const bundle of BUNDLES) expect(isRegisteredQuestionSet(bundle.questions)).toBe(true);
		expect(new Set(BUNDLES.map((b) => b.id)).size).toBe(BUNDLES.length);
	});

	it('only triage runs on the language rung', () => {
		expect(BUNDLES.filter((b) => b.runsOnLanguageRung).map((b) => b.id)).toEqual(['mail.triage']);
	});

	it.each(BUNDLES)('$id renders as ONE structured call and maps back', (bundle) => {
		const state = { subject: 'Invoice 42', body: 'Please send the invoice again.' };
		const prompt = renderDecisionPrompt(state, bundle.questions);
		for (const question of Object.values(bundle.questions)) {
			expect(prompt).toContain(question.instructions);
		}
		expect(prompt).toContain('Invoice 42');
		const object = Object.fromEntries(
			Object.entries(bundle.questions).map(([key, question]) => [
				key,
				question.type === 'choice' ? Object.keys(question.criteria)[0] : 0.9,
			])
		);
		expect(renderDecisionSchema(bundle.questions).safeParse(object).success).toBe(true);
		const answers = mapAnswers(bundle.questions, object);
		expect(Object.keys(answers).sort()).toEqual(Object.keys(bundle.questions).sort());
	});
});

describe('label projection', () => {
	it('reads a Choice only when it is peaked enough', () => {
		expect(choiceLabel(choiceAnswer('spam', CHOICE_THRESHOLD.min))).toBe('spam');
		expect(choiceLabel(choiceAnswer('spam', CHOICE_THRESHOLD.min - 0.01))).toBe(UNKNOWN_LABEL);
	});

	it('interprets the reply Noul at both thresholds, never informational for a complaint', () => {
		expect(interpretDisposition(DISPOSITION_THRESHOLD.reply, 'support')).toBe('reply');
		expect(interpretDisposition(0.5, 'support')).toBe(UNKNOWN_LABEL);
		expect(interpretDisposition(DISPOSITION_THRESHOLD.informational, 'support')).toBe(
			'informational'
		);
		expect(interpretDisposition(0.01, 'complaint')).toBe('reply');
	});

	it('projects the message bundles to a category and a disposition', () => {
		const labels = TEAM_MESSAGE_BUNDLE.project({
			category: choiceAnswer('complaint', 0.9),
			disposition: { kind: 'noul', probability: 0.1 },
		});
		expect(labels).toEqual({ category: 'complaint', disposition: 'reply' });
		expect(TRIAGE_BUNDLE.project({ triage: choiceAnswer('automated', 0.2) })).toEqual({
			triage: UNKNOWN_LABEL,
		});
	});

	it('abstains only when every label is unknown', () => {
		expect(isAbstention({ category: UNKNOWN_LABEL, disposition: UNKNOWN_LABEL })).toBe(true);
		expect(isAbstention({ category: 'support', disposition: UNKNOWN_LABEL })).toBe(false);
	});

	it('compares with today only on fields both settled', () => {
		expect(agreementWith({ category: 'support' }, undefined)).toBeUndefined();
		expect(agreementWith({ category: UNKNOWN_LABEL }, { category: 'support' })).toBeUndefined();
		expect(
			agreementWith({ category: 'support', disposition: 'reply' }, { category: 'support' })
		).toBe(true);
		expect(
			agreementWith(
				{ category: 'support', disposition: 'informational' },
				{ category: 'support', disposition: 'reply' }
			)
		).toBe(false);
	});
});

describe('the evidence state', () => {
	const evidence: DecisionEvidence = {
		surface: 'postbox',
		from: 'ada@example.com',
		to: ['Owner@Example.com'],
		cc: [],
		ownAddresses: ['owner@example.com'],
		subject: 'Lunch?',
		segments: [
			{ kind: 'fresh', text: 'Shall we have lunch on Friday?' },
			{ kind: 'quoted', text: 'Earlier mail' },
		],
		bulkHeaders: false,
		senderKnown: true,
	};

	it('is the message alone, its quoted history labelled', () => {
		expect(decisionMessageState(evidence)).toEqual({
			mailbox: 'personal mailbox',
			from: 'ada@example.com',
			to: ['Owner@Example.com'],
			cc: [],
			addressedToOwner: true,
			senderKnown: true,
			bulkHeaders: false,
			subject: 'Lunch?',
			body: 'Shall we have lunch on Friday?\n\n[quoted] Earlier mail',
		});
	});

	it('leaves senderKnown out where the surface has no honest answer', () => {
		const { senderKnown: _omit, ...team } = evidence;
		const state = decisionMessageState({ ...team, surface: 'team' });
		expect(state).not.toHaveProperty('senderKnown');
		expect(state).toMatchObject({ mailbox: 'team inbox' });
	});

	it('caps the body', () => {
		const long = [{ kind: 'fresh', text: 'x'.repeat(STATE_BODY_CHARS * 2) }];
		expect(evidenceBody(long)).toHaveLength(STATE_BODY_CHARS);
	});

	it('takes each segment’s text out of the canonical body', () => {
		const segmented = segmentMessage({
			text: 'Thanks!\n\nOn Monday, Ada wrote:\n> Lunch on Friday?',
			subject: 'Re: Lunch',
		});
		const segments = evidenceSegments(segmented);
		expect(segments.map((s) => s.kind)).toEqual(segmented.segments.map((s) => s.kind));
		expect(segments.map((s) => s.text).join('')).toContain('Thanks!');
		expect(segments.some((s) => s.kind !== 'fresh')).toBe(true);
	});

	it('hashes equal evidence equally and different evidence differently', () => {
		const state = decisionMessageState(evidence);
		expect(stateContentHash(state)).toBe(stateContentHash(decisionMessageState(evidence)));
		expect(stateContentHash(state)).not.toBe(
			stateContentHash(decisionMessageState({ ...evidence, subject: 'Dinner?' }))
		);
	});
});
