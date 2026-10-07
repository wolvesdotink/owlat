/**
 * The interpretation call contract (mail/interpret/schema.ts): a strict union
 * on `mode`, bounded arrays, and an actions-mode payload that can never carry
 * `latest` or `facts`.
 */

import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
	actionsModelSchema,
	actionsOutputSchema,
	briefModelSchema,
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

	it('hands the model the strict model schema per mode', () => {
		expect(interpretOutputSchemaFor('brief')).toBe(briefModelSchema);
		expect(interpretOutputSchemaFor('actions')).toBe(actionsModelSchema);
	});

	it('requires consequences from the model, but parses stored payloads without them', () => {
		const modelItem = { ...item, consequences: null };
		const model = { ...actionsPayload, items: [modelItem] };
		expect(actionsModelSchema.safeParse(model).success).toBe(true);
		expect(actionsModelSchema.safeParse(actionsPayload).success).toBe(false);
		// Every model result is also a valid parse-schema payload.
		expect(interpretOutputSchema.safeParse(model).success).toBe(true);
		expect(interpretOutputSchema.safeParse({ ...briefPayload, items: [modelItem] }).success).toBe(
			true
		);
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

/**
 * The JSON Schema the provider receives, built by the same conversion the AI
 * SDK applies to `runLlmObject`'s schema (`zodSchema` from `ai`). The OpenAI
 * adapter sends it with `strict: true`, which rejects any object whose
 * properties are not all listed in `required`, or that allows additional
 * properties.
 */
type JsonSchemaNode = {
	type?: string | string[];
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	additionalProperties?: unknown;
	items?: JsonSchemaNode | JsonSchemaNode[];
	anyOf?: JsonSchemaNode[];
	oneOf?: JsonSchemaNode[];
	allOf?: JsonSchemaNode[];
};

function strictViolations(node: JsonSchemaNode | undefined, path: string, out: string[]): void {
	if (!node || typeof node !== 'object') return;
	if (node.properties) {
		const keys = Object.keys(node.properties);
		const required = new Set(node.required ?? []);
		for (const key of keys) if (!required.has(key)) out.push(`${path}.${key} not required`);
		if (node.additionalProperties !== false) out.push(`${path} allows additional properties`);
		for (const [key, child] of Object.entries(node.properties)) {
			strictViolations(child, `${path}.${key}`, out);
		}
	}
	const items = Array.isArray(node.items) ? node.items : node.items ? [node.items] : [];
	for (const child of items) strictViolations(child, `${path}[]`, out);
	for (const [kind, list] of [
		['anyOf', node.anyOf],
		['oneOf', node.oneOf],
		['allOf', node.allOf],
	] as const) {
		list?.forEach((child, i) => strictViolations(child, `${path}<${kind}${i}>`, out));
	}
}

describe('provider-facing JSON Schema', () => {
	for (const mode of ['brief', 'actions'] as const) {
		it(`lists every property as required at every level (${mode})`, async () => {
			const json = (await zodSchema(interpretOutputSchemaFor(mode) as z.ZodType)
				.jsonSchema) as JsonSchemaNode;
			expect(json.type).toBe('object');
			const violations: string[] = [];
			strictViolations(json, '$', violations);
			expect(violations).toEqual([]);
			// Sanity: the walk reached the item level.
			const items = json.properties?.['items']?.items as JsonSchemaNode;
			expect(items.required).toContain('consequences');
		});
	}

	it('catches an optional property (the walk is not vacuous)', async () => {
		const json = (await zodSchema(interpretOutputSchema as z.ZodType).jsonSchema) as JsonSchemaNode;
		const violations: string[] = [];
		strictViolations(json, '$', violations);
		expect(violations.some((v) => v.endsWith('.consequences not required'))).toBe(true);
	});
});
