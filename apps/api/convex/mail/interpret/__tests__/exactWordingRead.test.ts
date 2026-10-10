/**
 * "Read the exact wording" is found by index, not from the newest extractions
 * (SPEC §7 legal mail). Only the CURRENT extraction of a source carries the flag:
 *   - the reducer stores the flag and reason on the extraction row;
 *   - an older legal message stays listed behind fifty ordinary ones;
 *   - a newer extraction that read the message and no longer asks for it
 *     clears the flag on the older row (only current rows stay flagged);
 *   - a failed re-run that did not read the message keeps the flag;
 *   - a page larger than the read limit says it is truncated.
 * Plus the grounding side of quote highlighting: hidden copies the scanner
 * strips are not counted in an evidence span's occurrence total.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { segmentMessage } from '@owlat/shared/mailSegments';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { styleHides } from '../../../agent/steps/security_scan/hiddenStyle';
import { EXACT_WORDING_PAGE, readExactWording } from '../briefRead';
import { quoteOccurrences } from '../quoteMatch';
import { itemSortKey } from '../counters';
import { modules, reduceResult, seedMailThread } from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

function applyArgs(
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	overrides: Record<string, unknown> = {}
) {
	return {
		source: { kind: 'mail' as const, id: messageId },
		threadRef: { kind: 'mail' as const, id: threadId },
		mode: 'brief' as const,
		contentRevision: 'rev-1',
		extractorVersion: 3,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound' as const,
		status: 'complete' as const,
		result: reduceResult({ exactWording: { reason: 'legal' } }),
		...overrides,
	};
}

async function ordinaryRows(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>,
	count: number
) {
	for (let i = 0; i < count; i++) {
		await ctx.db.insert('messageInterpretations', {
			threadKind: 'mail',
			mailThreadId: threadId,
			source: { kind: 'mail', id: messageId },
			sourceKey: `mail:ordinary-${i}`,
			contentRevision: 'r',
			extractorVersion: 2,
			mode: 'brief',
			status: 'complete',
			deletionEpoch: 0,
			appliedAt: SENT + i + 1,
			createdAt: SENT + i + 1,
			updatedAt: SENT + i + 1,
		});
	}
}

describe('readExactWording', () => {
	it('keeps an older legal message listed behind fifty ordinary ones', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		const stored = await t.run((ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(stored).toMatchObject({ isExactWordingRequired: true, exactWordingReason: 'legal' });

		await t.run((ctx) => ordinaryRows(ctx, threadId, messageId, 50));
		expect(await t.run((ctx) => readExactWording(ctx, threadId))).toEqual({
			messages: [{ messageId, reason: 'legal' }],
			isTruncated: false,
		});
	});

	it('drops it when a newer extraction of the message no longer asks for it', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId, {
				contentRevision: 'rev-2',
				expectedRevision: 1,
				result: reduceResult(),
			})
		);
		expect(await t.run((ctx) => readExactWording(ctx, threadId))).toEqual({
			messages: [],
			isTruncated: false,
		});
		const flagged = await t.run((ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread_exact_wording', (q) =>
					q.eq('mailThreadId', threadId).eq('isExactWordingRequired', true)
				)
				.collect()
		);
		expect(flagged).toEqual([]);
	});

	it('keeps it through a failed re-run that did not read the message', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId, {
				contentRevision: 'rev-2',
				expectedRevision: 1,
				status: 'failed',
				errorCode: 'model_error',
				result: undefined,
			})
		);
		const read = await t.run((ctx) => readExactWording(ctx, threadId));
		expect(read.messages).toEqual([{ messageId, reason: 'legal' }]);
	});

	it('says it is truncated past one page', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.run(async (ctx) => {
			for (let i = 0; i <= EXACT_WORDING_PAGE; i++) {
				await ctx.db.insert('messageInterpretations', {
					threadKind: 'mail',
					mailThreadId: threadId,
					source: { kind: 'mail', id: messageId },
					sourceKey: `mail:legal-${i}`,
					contentRevision: 'r',
					extractorVersion: 3,
					mode: 'brief',
					status: 'complete',
					isCurrent: true,
					isExactWordingRequired: true,
					exactWordingReason: 'legal',
					deletionEpoch: 0,
					appliedAt: SENT,
					createdAt: SENT,
					updatedAt: SENT,
				});
			}
		});
		const read = await t.run((ctx) => readExactWording(ctx, threadId));
		expect(read.messages).toHaveLength(EXACT_WORDING_PAGE);
		expect(read.isTruncated).toBe(true);
	});
});

describe('the reducer writes the list order', () => {
	it('stores listBucket and the compareForYou sortKey on a new item', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		const items = await t.run((ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_bucket_sort', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(items).toHaveLength(1);
		const item = items[0]!;
		expect(item.listBucket).toBeDefined();
		expect(item.sortKey).toBe(itemSortKey(item));
	});
});

describe('quoteOccurrences on scanner-stripped text', () => {
	it('counts composed and decomposed spellings alike (the reader shares the normalization)', () => {
		const text = 'Café and Cafe\u0301 again';
		const second = text.indexOf('Cafe\u0301');
		expect(quoteOccurrences(text, second, second + 5)).toEqual({ occurrence: 1, total: 2 });
	});

	it('does not count a hidden copy of the quoted words', () => {
		const segmented = segmentMessage(
			{
				html: '<p><span style="display:none">please confirm by Friday</span></p><p>We changed the terms: please confirm by Friday.</p>',
				subject: 'Terms',
			},
			{ styleHides }
		);
		const text = segmented.canonicalText;
		const at = text.indexOf('please confirm by Friday');
		expect(quoteOccurrences(text, at, at + 24)).toEqual({ occurrence: 0, total: 1 });
	});
});
