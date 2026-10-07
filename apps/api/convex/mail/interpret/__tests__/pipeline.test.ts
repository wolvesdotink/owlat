/**
 * The run's pure core (mail/interpret/pipeline.ts) end to end without a model:
 * a segmented message, a model output, grounding, the verifier's claims, the
 * reducer input, the run status and the needs-reply projection. Plus the
 * scope rules (scope.ts) and the Postbox projection (needsReplyProjection.ts).
 */

import { describe, expect, it } from 'vitest';
import { segmentMessage } from '@owlat/shared/mailSegments';
import { groundProposals } from '../ground';
import {
	buildInterpretInput,
	clampOutput,
	clampText,
	parseIsoMs,
	resolveParticipant,
	runStatusOf,
	toReduceResult,
	verifyClaimsOf,
} from '../pipeline';
import type { InterpretBriefOutput, InterpretInputParticipant } from '../schema';
import { scopeBody } from '../scope';
import { needsReplyProjectionOf, needsReplyResultOf } from '../needsReplyProjection';
import type { Id } from '../../../_generated/dataModel';

const segmented = segmentMessage({
	text:
		'Hi,\n\nCould you send me the signed contract by Friday? The invoice total is 1,200 EUR.\n\n' +
		'On Mon, Oct 5, 2026 at 9:00 AM Mara <mara@example.com> wrote:\n> Please also review the draft.',
	subject: 'Contract',
});
const fresh = segmented.segments.find((s) => s.kind === 'fresh')!;

const participants: InterpretInputParticipant[] = [
	{ ref: 'p1', role: 'from', email: 'jonas@example.com', name: 'Jonas', isUs: false },
	{ ref: 'p2', role: 'us', email: 'me@owlat.example', isUs: true },
];
const own = new Set(['me@owlat.example']);

function output(overrides: Partial<InterpretBriefOutput> = {}): InterpretBriefOutput {
	return {
		mode: 'brief',
		items: [
			{
				matchItemId: null,
				intent: 'request',
				facets: ['file', 'signature'],
				consequences: ['signature'],
				assertion: 'Send the signed contract',
				display: {
					en: 'Send Jonas the signed contract',
					de: 'Schick Jonas den unterschriebenen Vertrag',
				},
				requester: { ref: 'p1', name: null, email: null },
				responsible: { ref: 'p2', name: null, email: null },
				beneficiary: null,
				due: { phrase: 'by Friday', at: '2026-10-09', tz: null, ambiguous: false, condition: null },
				amount: null,
				options: null,
				quotes: [{ segmentId: fresh.id, text: 'send me the signed contract by Friday' }],
			},
			{
				matchItemId: null,
				intent: 'request',
				facets: ['documentReview'],
				consequences: [],
				assertion: 'Review the draft',
				display: { en: 'Review the draft', de: 'Prüf den Entwurf' },
				requester: { ref: null, name: 'Mara', email: 'mara@example.com' },
				responsible: { ref: 'p2', name: null, email: null },
				beneficiary: null,
				due: null,
				amount: null,
				options: null,
				// Quoted history: grounding drops it (not_fresh).
				quotes: [{ segmentId: segmented.segments[1]!.id, text: 'Please also review the draft.' }],
			},
		],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		meetingIntent: null,
		coverage: {
			segmentsRead: segmented.segments.map((s) => s.id),
			uncertain: false,
			overflow: false,
		},
		latest: {
			en: [
				{
					text: 'Jonas wants the signed contract by Friday.',
					quotes: [{ segmentId: fresh.id, text: 'signed contract by Friday' }],
				},
			],
			de: [
				{
					text: 'Jonas will den Vertrag bis Freitag.',
					quotes: [{ segmentId: fresh.id, text: 'signed contract by Friday' }],
				},
			],
		},
		facts: [
			{
				matchFactId: null,
				key: { entity: 'invoice', attribute: 'total', context: null },
				assertion: 'The invoice total is 1,200 EUR',
				value: { kind: 'money', value: 1200, currency: 'eur' },
				display: { en: 'Invoice total: 1,200 EUR', de: 'Rechnungssumme: 1.200 EUR' },
				quotes: [{ segmentId: fresh.id, text: 'The invoice total is 1,200 EUR.' }],
				supersedes: null,
				conflictsWith: null,
				reportedBy: { ref: 'p1', name: null, email: null },
			},
		],
		...overrides,
	};
}

describe('the pure run core', () => {
	it('builds the prompt input from the segmentation', () => {
		const input = buildInterpretInput({
			mode: 'actions',
			segmented,
			sentAt: 1,
			timezone: 'UTC',
			contentRevision: 'r',
			participants,
			openItems: [],
			isItemsOverflow: false,
			currentFacts: [{ id: 'f', key: 'k', assertion: 'a', evidenceExcerpt: '' }],
			isFactsOverflow: true,
			locales: ['en', 'de'],
		});
		expect(input.message.segments[0]).toMatchObject({ id: fresh.id, kind: 'fresh' });
		expect(input.message.segments[0]?.text).toContain('Could you send me the signed contract');
		// Actions mode never carries facts.
		expect(input.currentFacts).toEqual([]);
		expect(input.factsOverflow).toBe(false);
	});

	it('grounds, asks the verifier about the consequential item, and builds the reducer input', () => {
		const out = clampOutput(output());
		const grounding = groundProposals(out, segmented);
		expect(grounding.items).toHaveLength(1);
		const claims = verifyClaimsOf(grounding, segmented.canonicalText, {
			participants,
			itemText: () => undefined,
			factText: () => undefined,
		});
		expect(claims.map((c) => c.id)).toEqual(['item:0']);
		expect(claims[0]?.statement).toContain('the reader is asked or committed to');

		const result = toReduceResult(out, grounding, {
			mode: 'brief',
			canonicalText: segmented.canonicalText,
			participants,
			ownAddresses: own,
			timezone: 'Europe/Berlin',
			verdicts: new Map([['item:0', 'supported']]),
			checked: new Set(['item:0']),
		});
		expect(result.items[0]).toMatchObject({
			verify: 'passed',
			requester: { email: 'jonas@example.com', name: 'Jonas', isUs: false },
			responsible: { email: 'me@owlat.example', isUs: true },
			due: {
				phrase: 'by Friday',
				at: Date.parse('2026-10-09'),
				tz: 'Europe/Berlin',
				isAmbiguous: false,
			},
			consequences: ['signature'],
		});
		expect(result.items[0]?.evidence[0]?.quote).toBe('send me the signed contract by Friday');
		expect(result.latest?.en).toHaveLength(1);
		expect(result.facts?.[0]).toMatchObject({
			key: '["invoice","total",""]',
			value: { kind: 'money', value: 1200, currency: 'EUR' },
		});
		expect(result.dropped.grounding).toBe(1);
	});

	it('keeps an unverified consequential item as a proposal and drops a rejected one', () => {
		const out = clampOutput(output());
		const grounding = groundProposals(out, segmented);
		const base = {
			mode: 'brief' as const,
			canonicalText: segmented.canonicalText,
			participants,
			ownAddresses: own,
			timezone: 'UTC',
			checked: new Set(['item:0']),
		};
		expect(toReduceResult(out, grounding, { ...base, verdicts: new Map() }).items[0]?.verify).toBe(
			'proposal'
		);
		const rejected = toReduceResult(out, grounding, {
			...base,
			verdicts: new Map([['item:0', 'unsupported']]),
		});
		expect(rejected.items).toHaveLength(0);
		expect(rejected.dropped.verify).toBe(1);
	});

	it('withholds the latest update for short or security mail', () => {
		const out = clampOutput(output());
		const result = toReduceResult(out, groundProposals(out, segmented), {
			mode: 'brief',
			canonicalText: segmented.canonicalText,
			participants,
			ownAddresses: own,
			timezone: 'UTC',
			verdicts: new Map(),
			checked: new Set(),
			latestSuppressed: 'security',
		});
		expect(result.latest).toBeUndefined();
		expect(result.latestSuppressed).toBe('security');
		expect(result.items).toHaveLength(1);
	});

	it('marks overflow and grounding gaps partial', () => {
		const out = output();
		const grounding = groundProposals(out, segmented);
		const base = {
			grounding,
			output: out,
			isItemsOverflow: false,
			isFactsOverflow: false,
			truncatedSegmentIds: [] as string[],
			isVerifyIncomplete: false,
		};
		expect(runStatusOf(base)).toEqual({ status: 'complete' });
		expect(runStatusOf({ ...base, isItemsOverflow: true })).toEqual({
			status: 'partial',
			errorCode: 'overflow',
		});
		expect(runStatusOf({ ...base, truncatedSegmentIds: ['s0'] })).toEqual({
			status: 'partial',
			errorCode: 'overflow',
		});
		expect(runStatusOf({ ...base, isVerifyIncomplete: true })).toEqual({
			status: 'partial',
			errorCode: 'verify',
		});
		const failed = groundProposals(
			output({
				items: [
					{
						...output().items[0]!,
						quotes: [{ segmentId: fresh.id, text: 'words that are not there' }],
					},
				],
			}),
			segmented
		);
		expect(runStatusOf({ ...base, grounding: failed })).toEqual({
			status: 'partial',
			errorCode: 'grounding',
		});
	});

	it('projects the top owned item for the needs-reply flag', () => {
		const out = clampOutput(output());
		const result = toReduceResult(out, groundProposals(out, segmented), {
			mode: 'brief',
			canonicalText: segmented.canonicalText,
			participants,
			ownAddresses: own,
			timezone: 'UTC',
			verdicts: new Map([['item:0', 'supported']]),
			checked: new Set(['item:0']),
		});
		expect(needsReplyProjectionOf(result, 'de')).toEqual({
			replyIntent: 'request_for_action',
			urgency: 'normal',
			askSummary: 'Schick Jonas den unterschriebenen Vertrag',
			dueHint: '2026-10-09',
			isOnlyTheirs: false,
		});
	});
});

describe('helpers', () => {
	it('clamps at a word and strips control characters', () => {
		expect(clampText('a\u0000b  c', 10)).toBe('a b c');
		expect(clampText('one two three four', 10)).toBe('one two…');
	});

	it('parses only ISO dates', () => {
		expect(parseIsoMs('2026-10-09')).toBe(Date.parse('2026-10-09'));
		expect(parseIsoMs('next Friday')).toBeUndefined();
		expect(parseIsoMs(null)).toBeUndefined();
	});

	it('resolves participant refs, and unknown people by address', () => {
		expect(resolveParticipant({ ref: 'p2', name: null, email: null }, participants, own)).toEqual({
			email: 'me@owlat.example',
			isUs: true,
		});
		expect(
			resolveParticipant({ ref: null, name: 'Mara', email: 'Mara@Example.com' }, participants, own)
		).toEqual({
			email: 'mara@example.com',
			name: 'Mara',
			isUs: false,
		});
		expect(resolveParticipant({ ref: null, name: null, email: null }, participants, own)).toEqual({
			isUs: false,
		});
	});
});

describe('scopeBody', () => {
	const signed =
		'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nPlease pay invoice 7.\n-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n';

	it('reads only the signed block of a clearsigned verdict', () => {
		const scoped = scopeBody({
			text: `${signed}\nUnsigned trailer: wire it to another account.`,
			html: '<p>x</p>',
			subject: 'Invoice',
			attachments: [],
			signatureInfo: { isSigned: true, scope: 'clearsigned' },
		});
		expect(scoped).toMatchObject({ ok: true, signedScope: 'clearsigned' });
		if (!scoped.ok) throw new Error('unreachable');
		expect(scoped.text).toContain('Please pay invoice 7.');
		expect(scoped.text).not.toContain('Unsigned trailer');
		expect(scoped.html).toBeUndefined();
		expect(scoped.omitted).toEqual(['outside_signed_block', 'html_alternative']);
	});

	it('skips an encrypted body as undecryptable', () => {
		expect(
			scopeBody({
				subject: 'x',
				attachments: [{ contentType: 'application/pgp-encrypted' }],
			})
		).toEqual({ ok: false, skipReason: 'undecryptable' });
	});

	it('passes ordinary mail through', () => {
		expect(scopeBody({ text: 'hello', subject: 's', attachments: [] })).toEqual({
			ok: true,
			text: 'hello',
			subject: 's',
			omitted: [],
		});
	});
});

describe('needsReplyResultOf', () => {
	const latest = {
		messageId: 'msg1' as Id<'mailMessages'>,
		fromAddress: 'jonas@example.com',
		hasCalendarInvite: false,
	};

	it('queues a reply-expecting intent with the owned item as the ask', () => {
		const { decision, needsReply } = needsReplyResultOf(
			{
				replyIntent: 'direct_question',
				urgency: 'high',
				askSummary: 'Confirm the date',
				dueHint: '2026-10-09',
				isOnlyTheirs: false,
			},
			latest
		);
		expect(decision.needsReply).toBe(true);
		expect(needsReply).toMatchObject({
			source: 'llm',
			urgency: 'high',
			askSummary: 'Confirm the date',
			dueHint: '2026-10-09',
		});
	});

	it('keeps informational mail out even when it carries items', () => {
		expect(
			needsReplyResultOf(
				{ replyIntent: 'informational_update', urgency: 'low', isOnlyTheirs: false },
				latest
			).needsReply
		).toBeNull();
	});

	it('vetoes when every item is someone else’s', () => {
		const { decision } = needsReplyResultOf(
			{ replyIntent: 'request_for_action', urgency: 'normal', isOnlyTheirs: true },
			latest
		);
		expect(decision).toEqual({ needsReply: false, suppressedBy: 'model' });
	});

	it('never queues a reply to an unattended sender', () => {
		const { decision } = needsReplyResultOf(
			{ replyIntent: 'direct_question', urgency: 'normal', isOnlyTheirs: false },
			{ ...latest, fromAddress: 'no-reply@example.com' }
		);
		expect(decision.suppressedBy).toBe('unattended_sender');
	});
});
