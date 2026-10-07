/**
 * The "exact wording" signal (SPEC §7 legal mail) and the evidence occurrence
 * index the reader uses to mark the right passage:
 *   - the model schema requires `exactWording` (nullable reason); the parse
 *     schema tolerates payloads stored before it existed;
 *   - the reducer input carries it only when the model asked for it;
 *   - every evidence span knows which occurrence of its words it is.
 */

import { describe, expect, it } from 'vitest';
import { segmentMessage } from '@owlat/shared/mailSegments';
import { groundProposals } from '../ground';
import { toReduceResult } from '../pipeline';
import { clampOutput } from '../clamp';
import { quoteOccurrences } from '../quoteMatch';
import { briefModelSchema, briefOutputSchema, type InterpretBriefOutput } from '../schema';

const segmented = segmentMessage({
	text: 'please confirm. We changed the terms.\n\nAgain: please confirm by Friday, or the terms apply.',
	subject: 'Terms',
});
const fresh = segmented.segments.find((s) => s.kind === 'fresh')!;

function output(overrides: Partial<InterpretBriefOutput> = {}): InterpretBriefOutput {
	return {
		mode: 'brief',
		items: [
			{
				matchItemId: null,
				intent: 'request',
				facets: [],
				consequences: [],
				assertion: 'Confirm the new terms',
				display: { en: 'Confirm the new terms', de: 'Bestätige die neuen Bedingungen' },
				requester: { ref: null, name: 'Legal', email: 'legal@example.com' },
				responsible: { ref: null, name: null, email: null },
				beneficiary: null,
				due: null,
				amount: null,
				options: null,
				quotes: [{ segmentId: fresh.id, text: 'please confirm by Friday' }],
			},
		],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: [fresh.id], uncertain: false, overflow: false },
		latest: { en: [], de: [] },
		facts: [],
		exactWording: { isRequired: true, reason: 'terms' },
		...overrides,
	};
}

const opts = {
	mode: 'brief' as const,
	canonicalText: segmented.canonicalText,
	participants: [],
	ownAddresses: new Set<string>(),
	timezone: 'UTC',
	sentAt: 0,
	verdicts: new Map(),
	checked: new Set<string>(),
};

describe('exactWording', () => {
	it('is required in the model schema and optional when parsing a stored payload', () => {
		const { exactWording: _omit, ...legacy } = output();
		expect(briefModelSchema.safeParse(legacy).success).toBe(false);
		expect(briefModelSchema.safeParse(output()).success).toBe(true);
		expect(
			briefModelSchema.safeParse(output({ exactWording: { isRequired: false, reason: null } }))
				.success
		).toBe(true);
		expect(briefOutputSchema.safeParse(legacy).success).toBe(true);
	});

	it('reaches the reducer input only when the model asked for it', () => {
		const out = clampOutput(output());
		expect(toReduceResult(out, groundProposals(out, segmented), opts).exactWording).toEqual({
			reason: 'terms',
		});
		const plain = clampOutput(output({ exactWording: { isRequired: false, reason: 'legal' } }));
		expect(toReduceResult(plain, groundProposals(plain, segmented), opts).exactWording).toBe(
			undefined
		);
	});
});

describe('quoteOccurrences', () => {
	it('counts earlier occurrences of the same words', () => {
		const text = segmented.canonicalText;
		const first = text.indexOf('please confirm');
		const second = text.indexOf('please confirm', first + 1);
		expect(quoteOccurrences(text, first, first + 14)).toEqual({ occurrence: 0, total: 2 });
		expect(quoteOccurrences(text, second, second + 14)).toEqual({ occurrence: 1, total: 2 });
		// The whole quote is unique: the first (and only) occurrence.
		const quote = text.indexOf('please confirm by Friday');
		expect(quoteOccurrences(text, quote, quote + 24)).toEqual({ occurrence: 0, total: 1 });
	});

	it('stamps every evidence span with its occurrence', () => {
		const out = clampOutput(output());
		const result = toReduceResult(out, groundProposals(out, segmented), opts);
		expect(result.items[0]?.evidence[0]).toMatchObject({
			quote: 'please confirm by Friday',
			occurrence: 0,
			occurrenceCount: 1,
		});
	});
});
