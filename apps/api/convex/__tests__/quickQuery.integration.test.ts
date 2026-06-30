/**
 * quickQuery.ask — the Cmd+Shift+K Quick Query backend.
 *
 * Locks in the gates that run BEFORE any knowledge-entry read:
 *   - the `ai.knowledge` feature flag (mirrors knowledge/graph.ts `search`):
 *     with the flag off, `ask` must throw and dump nothing, even for a member.
 *   - org membership (requireOrgPermission 'knowledge:read'): a non-member is
 *     rejected even when the flag is on.
 * With the flag on and a member caller, the keyword full-text search returns the
 * matching entries' content as the answer with the entry titles as sources.
 *
 * The session helpers (lib/sessionOrganization) are mocked with a mutable
 * membership so we can exercise both the member and non-member paths.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures, createTestKnowledgeEntry } from './factories';

// Mutable session state so each test can pick membership. `member` drives the
// org-member floor that requireOrgPermission asserts.
const sessionMock = vi.hoisted(() => ({
	userId: 'user-member',
	member: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const requireMember = async () => {
		if (!sessionMock.member) {
			const err = new Error('You do not have access to this organization') as Error & {
				data?: { category: string };
			};
			err.data = { category: 'forbidden' };
			throw err;
		}
		return { userId: sessionMock.userId, role: 'owner' as const };
	};
	return {
		...actual,
		// authedMutation's wrapper calls getMutationContext before the handler;
		// requireOrgPermission runs inside the handler. Mock both so membership is
		// driven by sessionMock end-to-end.
		requireOrgMember: vi.fn().mockImplementation(requireMember),
		getMutationContext: vi.fn().mockImplementation(requireMember),
		requireOrgPermission: vi.fn().mockImplementation(requireMember),
		isActiveOrgMember: vi.fn().mockImplementation(async () => sessionMock.member),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider'),
	),
);

beforeEach(() => {
	sessionMock.member = true;
	sessionMock.userId = 'user-member';
});

describe('quickQuery.ask — feature gate', () => {
	it('throws when ai.knowledge is disabled, even for a member', async () => {
		const t = convexTest(schema, modules);
		// No instanceSettings row → ai.knowledge resolves to its default (off).
		await expect(t.mutation(api.quickQuery.ask, { question: 'budget' })).rejects.toThrow(
			/disabled|forbidden/i,
		);
	});

	it('rejects a non-member even when ai.knowledge is enabled', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		sessionMock.member = false;
		await expect(t.mutation(api.quickQuery.ask, { question: 'budget' })).rejects.toThrow(
			/access|forbidden/i,
		);
	});
});

describe('quickQuery.ask — keyword search over knowledge entries', () => {
	it('returns matching entry content as the answer and titles as sources', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({
					title: 'Q3 Budget',
					content: 'The marketing budget for Q3 is forty thousand euro.',
					searchableText: 'Q3 Budget The marketing budget for Q3 is forty thousand euro.',
				}),
			);
		});

		const res = await t.mutation(api.quickQuery.ask, { question: 'budget' });
		expect(res.answer).toContain('Q3 Budget');
		expect(res.answer).toContain('forty thousand euro');
		expect(res.sources).toHaveLength(1);
		expect(res.sources[0]!.title).toBe('Q3 Budget');
	});

	it('returns the no-match message when nothing keyword-overlaps', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		const res = await t.mutation(api.quickQuery.ask, { question: 'zzzznonexistentterm' });
		expect(res.sources).toHaveLength(0);
		expect(res.answer).toMatch(/couldn't find/i);
	});

	it('returns a prompt for an empty question without searching', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		const res = await t.mutation(api.quickQuery.ask, { question: '   ' });
		expect(res.sources).toHaveLength(0);
		expect(res.answer).toMatch(/enter a question/i);
	});
});
