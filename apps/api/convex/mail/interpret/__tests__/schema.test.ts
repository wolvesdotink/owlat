/**
 * The interpretation call contract (mail/interpret/schema.ts): a strict union
 * on `mode`, bounded arrays, and an actions-mode payload that can never carry
 * `latest` or `facts`.
 */

import { describe, expect, it } from 'vitest';
import {
	actionsOutputSchema,
	briefOutputSchema,
	interpretInputSchema,
	interpretOutputSchema,
	interpretOutputSchemaFor,
	MAX_INTERPRET_FACTS,
	MAX_INTERPRET_ITEMS,
	MAX_LATEST_LINES,
	type InterpretItemProposal,
} from '../schema';

const quote = { segmentId: 's1', text: 'Could you send the signed contract as a PDF?' };

const item: InterpretItemProposal = {
	matchItemId: null,
	intent: 'request',
	facets: ['file', 'signature'],
	assertion: 'Send the signed contract as a PDF',
	display: {
		en: 'Send the signed contract as a PDF',
		de: 'Schick den unterschriebenen Vertrag als PDF',
	},
	requester: { ref: 'p1', name: null, email: null },
	responsible: { ref: 'p0', name: null, email: null },
	beneficiary: null,
	due: {
		phrase: 'by Friday',
		at: '2026-10-09',
		tz: 'Europe/Berlin',
		ambiguous: false,
		condition: null,
	},
	amount: null,
	options: null,
	quotes: [quote],
};

const actionsPayload = {
	mode: 'actions' as const,
	items: [item],
	transitions: [{ itemId: 'item_1', to: 'done' as const, disposition: null, quotes: [quote] }],
	replyIntent: 'request_for_action' as const,
	urgency: 'normal' as const,
	meetingIntent: null,
	coverage: { segmentsRead: ['s1'], uncertain: false, overflow: false },
};

const briefPayload = {
	...actionsPayload,
	mode: 'brief' as const,
	latest: {
		en: [{ text: 'Jonas wants the signed contract.', quotes: [quote] }],
		de: [{ text: 'Jonas möchte den unterschriebenen Vertrag.', quotes: [quote] }],
	},
	facts: [
		{
			matchFactId: null,
			key: { entity: 'launch', attribute: 'date', context: null },
			assertion: 'The launch moved to 14 November',
			value: { kind: 'date' as const, at: '2026-11-14' },
			display: { en: 'Launch: 14 Nov', de: 'Launch: 14. Nov.' },
			quotes: [quote],
			supersedes: 'fact_1',
			conflictsWith: null,
			reportedBy: { ref: 'p1', name: null, email: null },
		},
	],
};

describe('interpretOutputSchema', () => {
	it('accepts a valid payload in both modes', () => {
		expect(interpretOutputSchema.parse(actionsPayload).mode).toBe('actions');
		expect(interpretOutputSchema.parse(briefPayload).mode).toBe('brief');
		expect(actionsOutputSchema.safeParse(actionsPayload).success).toBe(true);
		expect(briefOutputSchema.safeParse(briefPayload).success).toBe(true);
	});

	it('rejects latest or facts in actions mode', () => {
		const withLatest = { ...actionsPayload, latest: briefPayload.latest };
		const withFacts = { ...actionsPayload, facts: [] };
		expect(interpretOutputSchema.safeParse(withLatest).success).toBe(false);
		expect(interpretOutputSchema.safeParse(withFacts).success).toBe(false);
		expect(actionsOutputSchema.safeParse(withFacts).success).toBe(false);
	});

	it('requires latest and facts in brief mode', () => {
		const { latest: _latest, ...noLatest } = briefPayload;
		const { facts: _facts, ...noFacts } = briefPayload;
		expect(interpretOutputSchema.safeParse(noLatest).success).toBe(false);
		expect(interpretOutputSchema.safeParse(noFacts).success).toBe(false);
	});

	it('rejects unknown top-level keys and an unknown mode', () => {
		expect(interpretOutputSchema.safeParse({ ...actionsPayload, summary: 'x' }).success).toBe(
			false
		);
		expect(interpretOutputSchema.safeParse({ ...actionsPayload, mode: 'full' }).success).toBe(
			false
		);
	});

	it('bounds every array', () => {
		const tooManyItems = { ...actionsPayload, items: Array(MAX_INTERPRET_ITEMS + 1).fill(item) };
		expect(interpretOutputSchema.safeParse(tooManyItems).success).toBe(false);
		const tooManyFacts = {
			...briefPayload,
			facts: Array(MAX_INTERPRET_FACTS + 1).fill(briefPayload.facts[0]),
		};
		expect(interpretOutputSchema.safeParse(tooManyFacts).success).toBe(false);
		const tooManyLines = {
			...briefPayload,
			latest: {
				...briefPayload.latest,
				en: Array(MAX_LATEST_LINES + 1).fill(briefPayload.latest.en[0]),
			},
		};
		expect(interpretOutputSchema.safeParse(tooManyLines).success).toBe(false);
		const tooManyQuotes = {
			...actionsPayload,
			items: [{ ...item, quotes: [quote, quote, quote, quote] }],
		};
		expect(interpretOutputSchema.safeParse(tooManyQuotes).success).toBe(false);
	});

	it('carries consequence tags, and still parses a payload without them', () => {
		const disclosure = {
			...actionsPayload,
			items: [{ ...item, facets: ['information'], consequences: ['disclosure'] }],
		};
		const parsed = interpretOutputSchema.parse(disclosure);
		expect(parsed.items[0]?.consequences).toEqual(['disclosure']);
		expect(interpretOutputSchema.parse(actionsPayload).items[0]?.consequences).toBeUndefined();
		const unknown = { ...actionsPayload, items: [{ ...item, consequences: ['refund'] }] };
		expect(interpretOutputSchema.safeParse(unknown).success).toBe(false);
	});

	it('rejects values outside the shared vocabulary', () => {
		const badFacet = { ...actionsPayload, items: [{ ...item, facets: ['refund'] }] };
		const badIntent = { ...actionsPayload, replyIntent: 'maybe' };
		expect(interpretOutputSchema.safeParse(badFacet).success).toBe(false);
		expect(interpretOutputSchema.safeParse(badIntent).success).toBe(false);
	});

	it('hands the model a plain object schema per mode', () => {
		expect(interpretOutputSchemaFor('brief')).toBe(briefOutputSchema);
		expect(interpretOutputSchemaFor('actions')).toBe(actionsOutputSchema);
	});
});

describe('interpretInputSchema', () => {
	it('accepts a prompt input', () => {
		const input = {
			mode: 'brief',
			message: {
				segments: [{ id: 's1', kind: 'fresh', text: quote.text, author: { name: 'Jonas' } }],
				sentAt: 1_760_000_000_000,
				timezone: 'Europe/Berlin',
				sourceRevision: 'rev-abc',
			},
			participants: [
				{ ref: 'p0', role: 'us', isUs: true },
				{ ref: 'p1', role: 'from', name: 'Jonas', email: 'jonas@owlat.example', isUs: false },
			],
			openItems: [],
			itemsOverflow: false,
			currentFacts: [],
			factsOverflow: false,
			locales: ['en', 'de'],
		};
		expect(interpretInputSchema.safeParse(input).success).toBe(true);
		expect(
			interpretInputSchema.safeParse({
				...input,
				message: { ...input.message, segments: [{ id: 's1', kind: 'body', text: '' }] },
			}).success
		).toBe(false);
	});
});
