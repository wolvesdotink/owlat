/**
 * Thread brief schema (schema/threadBrief.ts) and its thread reference
 * (lib/validators/threadRef.ts): the threadRef split round-trips, the Convex
 * literal unions match the shared tuples, and one realistic row of each of the
 * seven tables validates against the schema.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import {
	ACTIVITY_TYPES,
	ITEM_FACETS,
	ITEM_STATUSES,
	RESPONSE_STANCES,
} from '@owlat/shared/threadBrief';
import schema from '../../schema';
import { THREAD_BRIEF_TABLES, threadBriefTables } from '../threadBrief';
import type { Id } from '../../_generated/dataModel';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import {
	isSameThreadRef,
	rowMatchesThreadRef,
	threadRefFromFields,
	threadRefKey,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import {
	activityTypeValidator,
	draftRefFromFields,
	draftRefToFields,
	interpretationSourceKey,
	itemFacetValidator,
	itemStatusValidator,
	responseStanceValidator,
} from '../../lib/validators/threadBrief';

const mailThread = 'mailThreadId' as Id<'mailThreads'>;
const teamThread = 'teamThreadId' as Id<'conversationThreads'>;

describe('threadRef', () => {
	it('splits into the indexed columns and back', () => {
		const refs: ThreadRef[] = [
			{ kind: 'mail', id: mailThread },
			{ kind: 'team', id: teamThread },
		];
		for (const ref of refs) {
			const fields = threadRefToFields(ref);
			expect(threadRefFromFields(fields)).toEqual(ref);
			expect(rowMatchesThreadRef(fields, ref)).toBe(true);
		}
		expect(threadRefToFields(refs[0]!)).toEqual({ threadKind: 'mail', mailThreadId: mailThread });
		expect(threadRefToFields(refs[1]!)).toEqual({
			threadKind: 'team',
			conversationThreadId: teamThread,
		});
		expect(rowMatchesThreadRef(threadRefToFields(refs[0]!), refs[1]!)).toBe(false);
	});

	it('refuses columns that break the xor invariant', () => {
		expect(() => threadRefFromFields({ threadKind: 'mail' })).toThrow();
		expect(() =>
			threadRefFromFields({ threadKind: 'mail', conversationThreadId: teamThread })
		).toThrow();
		expect(() =>
			threadRefFromFields({
				threadKind: 'team',
				conversationThreadId: teamThread,
				mailThreadId: mailThread,
			})
		).toThrow();
	});

	it('keys and compares references', () => {
		expect(threadRefKey({ kind: 'mail', id: mailThread })).toBe('mail:mailThreadId');
		expect(
			isSameThreadRef({ kind: 'mail', id: mailThread }, { kind: 'mail', id: mailThread })
		).toBe(true);
		expect(
			isSameThreadRef({ kind: 'mail', id: mailThread }, { kind: 'team', id: mailThread as never })
		).toBe(false);
	});
});

describe('thread brief validators', () => {
	it('mirror the shared tuples', () => {
		const members = (validator: { members: Array<{ value: unknown }> }) =>
			validator.members.map((member) => member.value);
		expect(members(itemFacetValidator)).toEqual([...ITEM_FACETS]);
		expect(members(itemStatusValidator)).toEqual([...ITEM_STATUSES]);
		expect(members(responseStanceValidator)).toEqual([...RESPONSE_STANCES]);
		expect(members(activityTypeValidator)).toEqual([...ACTIVITY_TYPES]);
	});

	it('round-trips draft refs and keys sources', () => {
		const mailDraft = { kind: 'mailDraft' as const, id: 'd1' as Id<'mailDrafts'> };
		const team = { kind: 'inboundDraft' as const, id: 'm1' as Id<'inboundMessages'> };
		expect(draftRefFromFields(draftRefToFields(mailDraft))).toEqual(mailDraft);
		expect(draftRefFromFields(draftRefToFields(team))).toEqual(team);
		expect(() => draftRefFromFields({ draftKind: 'mailDraft' })).toThrow();
		expect(interpretationSourceKey({ kind: 'mail', id: 'x' as Id<'mailMessages'> })).toBe('mail:x');
	});
});

describe('thread brief tables', () => {
	it('find every row of one thread in each table (erasure, scope invalidation)', () => {
		const perThread: Record<string, [string, string]> = {
			messageInterpretations: ['by_mail_thread', 'by_conversation_thread'],
			threadItems: ['by_mail_thread_and_status', 'by_conversation_thread_and_status'],
			threadActivity: ['by_mail_thread_and_seq', 'by_conversation_thread_and_seq'],
			threadBriefs: ['by_mail_thread', 'by_conversation_thread'],
			threadViewerState: ['by_mail_thread', 'by_conversation_thread'],
			draftResponsePlans: ['by_mail_thread', 'by_conversation_thread'],
		};
		for (const [table, [mailIndex, teamIndex]] of Object.entries(perThread)) {
			const { indexes } = (
				threadBriefTables as unknown as Record<
					string,
					{ indexes: Array<{ indexDescriptor: string; fields: string[] }> }
				>
			)[table]!;
			const first = (name: string) => indexes.find((i) => i.indexDescriptor === name)?.fields[0];
			expect(first(mailIndex), `${table}.${mailIndex}`).toBe('mailThreadId');
			expect(first(teamIndex), `${table}.${teamIndex}`).toBe('conversationThreadId');
		}
	});

	it('are all listed in THREAD_BRIEF_TABLES', () => {
		expect([...THREAD_BRIEF_TABLES].sort()).toEqual(Object.keys(threadBriefTables).sort());
	});

	it('accept one realistic row each', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId);
		await t.run(async (ctx) => {
			const now = Date.now();
			const message = await ctx.db.get(messageId);
			const ref: ThreadRef = { kind: 'mail', id: message!.threadId };
			const thread = threadRefToFields(ref);
			const source = { kind: 'mail' as const, id: messageId };
			const evidence = { source, segmentId: 's1', start: 0, end: 12, contentRevision: 'rev1' };
			const display = { en: 'atrest:1:sealed-en', de: 'atrest:1:sealed-de' };
			const us = { isUs: true };
			const them = { email: 'jonas@owlat.example', name: 'Jonas', isUs: false };

			const interpretationId = await ctx.db.insert('messageInterpretations', {
				...thread,
				source,
				sourceKey: interpretationSourceKey(source),
				contentRevision: 'rev1',
				extractorVersion: 1,
				mode: 'brief',
				status: 'complete',
				sourceManifest: {
					segments: [{ id: 's1', kind: 'fresh', start: 0, end: 40 }],
					isUncertain: false,
				},
				coverage: { segmentsRead: ['s1'], isUncertain: false, isOverflow: false },
				payload: 'atrest:1:payload',
				payloadVersion: 1,
				deletionEpoch: 0,
				createdAt: now,
				updatedAt: now,
			});
			const factId = await ctx.db.insert('threadFacts', {
				...thread,
				factKey: 'launch|date|',
				assertion: 'atrest:1:assertion',
				display,
				value: { kind: 'date', at: now },
				evidence: [evidence],
				provenance: 'reported',
				status: 'current',
				revision: 1,
				createdAt: now,
				updatedAt: now,
			});
			const itemId = await ctx.db.insert('threadItems', {
				...thread,
				mailboxId,
				revision: 1,
				intent: 'request',
				facets: ['information'],
				consequences: ['disclosure'],
				assertion: 'atrest:1:assertion',
				display,
				requester: them,
				responsible: us,
				responsibility: 'us',
				status: 'open',
				disposition: 'unanswered',
				due: { phrase: 'by Friday', at: now, isAmbiguous: false },
				evidence: [evidence],
				verify: 'na',
				askedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('threadActivity', {
				...thread,
				seq: 1,
				idempotencyKey: `item_opened:${itemId}`,
				type: 'item_opened',
				actor: { kind: 'sender' },
				provenance: 'reported',
				visibility: 'substance',
				itemId,
				itemRevision: 1,
				delta: { statusTo: 'open', factId },
				eventAt: now,
				recordedAt: now,
			});
			await ctx.db.insert('threadBriefs', {
				...thread,
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				checkpoint: { sourceKey: interpretationSourceKey(source), sourceAt: now, interpretationId },
				lastActivitySeq: 1,
				completeness: 'complete',
				deletionEpoch: 0,
				updatedAt: now,
			});
			await ctx.db.insert('threadViewerState', {
				...thread,
				userId: 'user-A',
				viewOverride: 'conversation',
				seenInterpretationRevision: 1,
				seenActivitySeq: 1,
				updatedAt: now,
			});
			const draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['jonas@owlat.example'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'a@owlat.test',
				subject: 'Re: hello',
				bodyHtml: '<p>hi</p>',
				attachments: [],
				state: 'draft',
				lastEditedAt: now,
				createdAt: now,
			});
			await ctx.db.insert('draftResponsePlans', {
				...thread,
				...draftRefToFields({ kind: 'mailDraft', id: draftId }),
				threadRevision: 1,
				itemRevisions: [{ itemId, revision: 1 }],
				stances: [{ itemId, stance: 'answer', source: 'default' }],
				ownerInputs: [],
				coverage: [{ itemId, spans: [{ start: 0, end: 10 }], verdict: 'addressed' }],
				newPromises: [],
				fileClaims: [{ text: 'atrest:1:claim', spans: [], isMatched: false }],
				draftHash: 'hash',
				verdict: 'gaps',
				createdAt: now,
				updatedAt: now,
			});

			const stored = await ctx.db.get(itemId);
			expect(threadRefFromFields(stored!)).toEqual(ref);
		});
	});
});
