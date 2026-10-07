/**
 * "Read the exact wording" is found by index, not from the newest extractions
 * (SPEC §7 legal mail):
 *   - the reducer stores the flag and reason on the extraction row;
 *   - an older legal message stays listed behind fifty ordinary ones;
 *   - a newer extraction of the same message that no longer asks for it wins.
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
import { readExactWording } from '../briefRead';
import { quoteOccurrences } from '../quoteMatch';
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
		extractorVersion: 2,
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
		expect(await t.run((ctx) => readExactWording(ctx, threadId))).toEqual([
			{ messageId, reason: 'legal' },
		]);
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
		expect(await t.run((ctx) => readExactWording(ctx, threadId))).toEqual([]);
	});
});

describe('quoteOccurrences on scanner-stripped text', () => {
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
