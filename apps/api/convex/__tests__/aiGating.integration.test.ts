/**
 * Auth + input gates on the AI surface.
 *
 * These tests lock in the gates that run BEFORE any LLM / embedding / network
 * call on the AI-facing entry points:
 *
 *   - visualizationAgent.ts `createFromPrompt` (authedMutation): requireAdminContext
 *     rejects a non-admin; the prompt-length bound (STRING_LIMITS.DESCRIPTION
 *     = 5000) rejects an over-cap prompt BEFORE the scheduled LLM action; a valid
 *     admin + short prompt inserts the placeholder row and schedules generation
 *     (the LLM action is scheduled, never run here).
 *   - the live-data allowlist: createFromPrompt's `dataset` arg only accepts the
 *     fixed DATASET_KEYS union (datasetKeyValidator) — a free-form prompt can
 *     never route to arbitrary account data.
 *   - knowledge contact-scoping: lib/contactScope.ts isContactScopeVisible —
 *     an entry scoped to contact A is NOT visible when scoping to contact B;
 *     org-general + org-wide visibility rules hold (pure-helper unit tests).
 *
 * The LLM dispatch seam (lib/llm/dispatch) is mocked so no real model is called;
 * the session helpers (lib/sessionOrganization) are mocked with a mutable role /
 * membership so we can exercise both the member and non-member / admin and
 * non-admin paths. The auth + input gates all run before any external call, so
 * we can assert rejection without a working external mock.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures, createTestContact } from './factories';
import { isContactScopeVisible } from '../lib/contactScope';
import type { Id } from '../_generated/dataModel';

// Mutable session state so each test can pick a role and membership. `member`
// drives the org-member floor (authedQuery / authedMutation / authedAction);
// `role` drives requireAdminContext (visualizationAgent admin gate).
const sessionMock = vi.hoisted(() => ({
	userId: 'user-admin',
	role: 'owner' as 'owner' | 'admin' | 'editor',
	member: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const ctx = () => ({ userId: sessionMock.userId, role: sessionMock.role });
	const requireMember = async () => {
		if (!sessionMock.member) {
			// Mirror requireOrgMember's forbidden branch for a non-member identity.
			const err = new Error('You do not have access to this organization') as Error & {
				data?: { category: string };
			};
			err.data = { category: 'forbidden' };
			throw err;
		}
		return ctx();
	};
	const requireAdmin = async () => {
		await requireMember();
		if (sessionMock.role === 'editor') {
			const err = new Error('Only owners and admins can perform this action') as Error & {
				data?: { category: string };
			};
			err.data = { category: 'forbidden' };
			throw err;
		}
		return ctx();
	};
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(requireMember),
		getMutationContext: vi.fn().mockImplementation(requireMember),
		isActiveOrgMember: vi.fn().mockImplementation(async () => sessionMock.member),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
		requireAdminContext: vi.fn().mockImplementation(requireAdmin),
		requireOrgPermission: vi.fn().mockImplementation(requireMember),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: sessionMock.userId, issuer: 'test', tokenIdentifier: 'test|user' }),
	};
});

// The LLM seam — assert it is NEVER reached in any gate test. If a gate failed
// open and execution fell through to a real model call, this mock would record
// it (and the "never called" expectations below would fail).
const runLlmTextMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual('../lib/llm/dispatch');
	return {
		...actual,
		runLlmText: runLlmTextMock,
	};
});

// Glob that INCLUDES visualizationAgent + assistant + the retrieval modules the
// assistant action calls (knowledge/retrieval, semanticFileProcessing). We keep
// the heavy agent-pipeline modules excluded — they aren't on the path under
// test and convex-test cannot bundle them here. semanticFileProcessing and
// visualizationAgent are deliberately re-included (they're dropped by the
// default template glob) because they are the surfaces under test / on-path.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction'),
	),
);

const setSession = (
	opts: { role?: 'owner' | 'admin' | 'editor'; member?: boolean; userId?: string } = {},
) => {
	sessionMock.role = opts.role ?? 'owner';
	sessionMock.member = opts.member ?? true;
	sessionMock.userId = opts.userId ?? 'user-admin';
};

beforeEach(() => {
	setSession({ role: 'owner', member: true });
	runLlmTextMock.mockReset();
});

// ============================================================
// visualizationAgent.createFromPrompt — admin + prompt-length gates
// ============================================================

describe('visualizationAgent.createFromPrompt — admin gate', () => {
	it('rejects a non-admin (editor) caller', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'editor', member: true });

		await expect(
			t.mutation(api.visualizationAgent.createFromPrompt, { prompt: 'chart our growth' }),
		).rejects.toThrow();

		// Nothing was inserted.
		await t.run(async (ctx) => {
			const all = await ctx.db.query('visualizations').collect();
			expect(all).toHaveLength(0);
		});
	});

	it('allows an admin and inserts a placeholder row + schedules generation', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });

		const id = await t.mutation(api.visualizationAgent.createFromPrompt, {
			prompt: 'show contact growth',
		});
		expect(id).toBeDefined();

		await t.run(async (ctx) => {
			const viz = await ctx.db.get(id);
			expect(viz).not.toBeNull();
			expect(viz!.title).toBe('show contact growth');
			expect(viz!.description).toBe('show contact growth');
			// Placeholder HTML, not generated content — the LLM action is scheduled,
			// not run inline.
			expect(viz!.html).toContain('Generating visualization');
			expect(viz!.pinned).toBe(false);
		});

		// createFromPrompt only SCHEDULES the generate action; it never calls the
		// LLM itself.
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});
});

describe('visualizationAgent.createFromPrompt — prompt-length bound', () => {
	it('rejects a prompt over STRING_LIMITS.DESCRIPTION (5000) before scheduling', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'owner', member: true });

		const overCap = 'a'.repeat(5001);
		await expect(
			t.mutation(api.visualizationAgent.createFromPrompt, { prompt: overCap }),
		).rejects.toThrow(/at most 5000 characters/);

		// The bound runs before the placeholder insert, so nothing persisted.
		await t.run(async (ctx) => {
			const all = await ctx.db.query('visualizations').collect();
			expect(all).toHaveLength(0);
		});
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('accepts a prompt exactly at the 5000-char cap', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'owner', member: true });

		const atCap = 'a'.repeat(5000);
		const id = await t.mutation(api.visualizationAgent.createFromPrompt, { prompt: atCap });
		expect(id).toBeDefined();
		await t.run(async (ctx) => {
			const viz = await ctx.db.get(id);
			expect(viz).not.toBeNull();
			// Title is sliced to 100 chars.
			expect(viz!.title.length).toBe(100);
		});
	});
});

// ============================================================
// Live-data allowlist — only the fixed dataset keys are accepted
// ============================================================

describe('visualizationAgent.createFromPrompt — live-data allowlist', () => {
	it('accepts each allowlisted dataset key', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });

		for (const dataset of [
			'email_delivery_30d',
			'agent_health',
			'contact_growth',
			'campaign_performance',
		] as const) {
			const id = await t.mutation(api.visualizationAgent.createFromPrompt, {
				prompt: `chart ${dataset}`,
				dataset,
			});
			expect(id).toBeDefined();
		}
	});

	it('rejects an arbitrary / free-form dataset key (no raw-query channel to account data)', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });

		// A dataset value outside the fixed union is rejected by Convex arg
		// validation before the handler runs — there is no path to inject a raw
		// query string or an off-allowlist table.
		await expect(
			t.mutation(api.visualizationAgent.createFromPrompt, {
				prompt: 'dump everything',
				// @ts-expect-error — deliberately passing an off-allowlist key.
				dataset: 'all_contacts_pii',
			}),
		).rejects.toThrow();

		await t.run(async (ctx) => {
			const all = await ctx.db.query('visualizations').collect();
			expect(all).toHaveLength(0);
		});
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('defaults to no dataset (illustrative) when dataset is omitted', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });

		const id = await t.mutation(api.visualizationAgent.createFromPrompt, {
			prompt: 'just make something pretty',
		});
		await t.run(async (ctx) => {
			const viz = await ctx.db.get(id);
			// No dataKey is persisted at create time; live data is opt-in only.
			expect(viz!.dataQuery).toBeUndefined();
		});
	});
});

// ============================================================
// visualizationAgent.regenerate — refresh the persisted live dataset
// ============================================================

describe('visualizationAgent.regenerate — live-data refresh', () => {
	// Insert a visualization row directly so we control its dataQuery.
	const insertViz = async (
		t: TestConvex<typeof schema>,
		dataQuery: string | undefined,
	): Promise<Id<'visualizations'>> =>
		t.run(async (ctx) =>
			ctx.db.insert('visualizations', {
				title: 'Email delivery',
				description: 'chart our email delivery',
				html: '<!DOCTYPE html><html><body>old</body></html>',
				dataQuery,
				pinned: false,
				createdBy: 'user',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

	it('rejects a non-admin (editor) caller', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });
		const id = await insertViz(t, 'email_delivery_30d');

		setSession({ role: 'editor', member: true });
		await expect(t.mutation(api.visualizationAgent.regenerate, { id })).rejects.toThrow();
	});

	it('re-schedules generation with the persisted allowlisted dataset', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });
		const id = await insertViz(t, 'email_delivery_30d');

		await t.mutation(api.visualizationAgent.regenerate, { id });

		// The row is flipped to the refreshing placeholder; regenerate only
		// schedules the generate action (no LLM call runs here).
		await t.run(async (ctx) => {
			const viz = await ctx.db.get(id);
			expect(viz!.html).toContain('Refreshing visualization');
			// dataQuery is preserved so the chart stays live after the refresh.
			expect(viz!.dataQuery).toBe('email_delivery_30d');
		});
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('rejects an illustrative visualization with no dataset to refresh', async () => {
		const t = convexTest(schema, modules);
		setSession({ role: 'admin', member: true });
		const id = await insertViz(t, undefined);

		await expect(t.mutation(api.visualizationAgent.regenerate, { id })).rejects.toThrow(
			/illustrative sample data/,
		);

		// Untouched — no placeholder flip, nothing scheduled.
		await t.run(async (ctx) => {
			const viz = await ctx.db.get(id);
			expect(viz!.html).toContain('old');
		});
	});
});

// ============================================================
// knowledge contact-scoping — isContactScopeVisible (pure helper)
// ============================================================

describe('isContactScopeVisible — contact-scope data isolation', () => {
	// Convex Ids are opaque strings at runtime; cast string literals for the
	// pure-function unit test.
	const contactA = 'contact_aaaaaaaaaa' as Id<'contacts'>;
	const contactB = 'contact_bbbbbbbbbb' as Id<'contacts'>;

	it('org-general rows (no contactIds) are visible to any scope', () => {
		expect(isContactScopeVisible(undefined, contactA)).toBe(true);
		expect(isContactScopeVisible([], contactA)).toBe(true);
		expect(isContactScopeVisible(undefined, 'org-general-only')).toBe(true);
		expect(isContactScopeVisible([], 'org-general-only')).toBe(true);
	});

	it('an entry scoped to contact A is NOT visible when scoping to contact B', () => {
		expect(isContactScopeVisible([contactA], contactB)).toBe(false);
		expect(isContactScopeVisible([contactB], contactA)).toBe(false);
	});

	it('an entry scoped to contact A IS visible when scoping to contact A', () => {
		expect(isContactScopeVisible([contactA], contactA)).toBe(true);
		// Membership in a multi-contact list is enough.
		expect(isContactScopeVisible([contactB, contactA], contactA)).toBe(true);
	});

	it('a contact-linked entry is hidden from the org-general-only scope (fail closed)', () => {
		expect(isContactScopeVisible([contactA], 'org-general-only')).toBe(false);
		expect(isContactScopeVisible([contactA, contactB], 'org-general-only')).toBe(false);
	});

	it('a draft for contact A never surfaces a row linked exclusively to contact B', () => {
		// The core data-isolation invariant: reply drafted for A, row owned by B.
		const rowOwnedByB: Id<'contacts'>[] = [contactB];
		expect(isContactScopeVisible(rowOwnedByB, contactA)).toBe(false);
	});
});

// ============================================================
// Sanity: a member-owned contact + scoping wiring through the harness
// ============================================================

describe('contact-scope wiring sanity', () => {
	it('inserts a contact and confirms the helper distinguishes it from a sibling', async () => {
		const t: TestConvex<typeof schema> = convexTest(schema, modules);
		let aId: Id<'contacts'>;
		let bId: Id<'contacts'>;
		await t.run(async (ctx) => {
			aId = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			bId = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
		});
		// Real Convex Ids from the harness, not hand-crafted literals.
		expect(isContactScopeVisible([aId!], aId!)).toBe(true);
		expect(isContactScopeVisible([aId!], bId!)).toBe(false);
	});
});
