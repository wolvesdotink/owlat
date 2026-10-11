/**
 * "Where things stand" strikes through the value a later message replaced
 * (plan §4.1). The brief lists current facts only, so each current fact
 * carries its direct predecessor (`previous`), opened in the viewer's locale,
 * read from the same thread only.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { modules, reduceResult, seedMailThread, type Test } from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' },
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => true),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);
const FRIDAY = Date.UTC(2026, 9, 9);
const MONDAY = Date.UTC(2026, 9, 12);

async function insertFact(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	over: {
		status: 'current' | 'superseded';
		at: number;
		en: string;
		de: string;
		supersedesId?: Id<'threadFacts'>;
	}
): Promise<Id<'threadFacts'>> {
	return ctx.db.insert('threadFacts', {
		threadKind: 'mail',
		mailThreadId: threadId,
		factKey: '["launch","date",""]',
		assertion: over.en,
		display: { en: over.en, de: over.de },
		value: { kind: 'date', at: over.at },
		evidence: [],
		provenance: 'reported',
		status: over.status,
		...(over.supersedesId ? { supersedesId: over.supersedesId } : {}),
		revision: 1,
		createdAt: SENT,
		updatedAt: SENT,
	});
}

async function interpreted(t: Test) {
	const { messageId, threadId } = await seedMailThread(t);
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ facts: [] }),
	});
	return threadId;
}

async function standing(t: Test, threadId: Id<'mailThreads'>, locale = 'en') {
	const view = await t.query(api.mail.interpret.brief.get, {
		threadRef: { kind: 'mail', id: threadId },
		locale,
	});
	if (view?.mode !== 'brief') throw new Error('expected a brief');
	return view.standing?.facts ?? [];
}

describe('brief.get: the value a current fact replaced', () => {
	it('returns Monday with Friday as its previous value', async () => {
		const t = convexTest(schema, modules);
		const threadId = await interpreted(t);
		await t.run(async (ctx) => {
			const friday = await insertFact(ctx, threadId, {
				status: 'superseded',
				at: FRIDAY,
				en: 'Launch on Friday',
				de: 'Start am Freitag',
			});
			await insertFact(ctx, threadId, {
				status: 'current',
				at: MONDAY,
				en: 'Launch on Monday',
				de: 'Start am Montag',
				supersedesId: friday,
			});
		});
		const facts = await standing(t, threadId);
		// Only the current fact is listed …
		expect(facts.map((f) => f.text)).toEqual(['Launch on Monday']);
		// … and it carries what it replaced, opened, in the viewer's locale.
		expect(facts[0]?.previous).toEqual({
			text: 'Launch on Friday',
			value: { kind: 'date', at: FRIDAY },
		});
		expect((await standing(t, threadId, 'de-DE'))[0]?.previous?.text).toBe('Start am Freitag');
	});

	it('never reads a predecessor from another thread', async () => {
		const t = convexTest(schema, modules);
		const threadId = await interpreted(t);
		const other = await interpreted(t);
		await t.run(async (ctx) => {
			const foreign = await insertFact(ctx, other, {
				status: 'superseded',
				at: FRIDAY,
				en: 'Someone else’s Friday',
				de: 'Fremder Freitag',
			});
			await insertFact(ctx, threadId, {
				status: 'current',
				at: MONDAY,
				en: 'Launch on Monday',
				de: 'Start am Montag',
				supersedesId: foreign,
			});
		});
		const facts = await standing(t, threadId);
		expect(facts[0]?.text).toBe('Launch on Monday');
		expect(facts[0]?.previous).toBeUndefined();
	});
});
