/**
 * Operator-console read authorization (P1 — read/write authz symmetry).
 *
 * Several operator-console surfaces had admin-gated WRITES but member-visible
 * READS. Those reads are now gated behind `organization:manage`
 * (requireOrgPermission inside the handler). These tests lock that in for a
 * representative read from each affected module: a non-admin member (`editor`)
 * must be rejected with `forbidden`, while an admin (`owner`/`admin`) succeeds.
 *
 * The session helpers are mocked with a mutable role so each test can pick a
 * member role. `requireOrgPermission` is given a role-aware implementation that
 * mirrors production semantics (`hasPermission(role, 'organization:manage')`):
 * an `editor` is rejected with `forbidden`; `owner`/`admin` pass. This asserts
 * both that each handler actually calls the gate AND that the gate's role
 * decision is correct — the same pattern the aiGating suite uses for the
 * `requireAdminContext` write gate.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { OrganizationRole } from '../lib/sessionOrganization';
import {
	createTestAutonomyRule,
	createTestAgentAction,
	createTestInboundMessage,
	enableFeatures,
} from './factories';

// Mutable role each test selects.
let mockRole: OrganizationRole = 'owner';

function throwForbidden(): never {
	const err = new Error("You don't have permission to perform this action") as Error & {
		data?: { category: string };
	};
	err.data = { category: 'forbidden' };
	throw err;
}

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization',
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole });
	return {
		...actual,
		// The org-member floor (authedQuery) — always a member here; the role
		// distinction is what the in-handler requireOrgPermission decides.
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ctx()),
		// Role-aware gate: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
});

// Mock the heavy LLM provider import chain so visualizationAgent can load in the
// vitest bundle (its read queries never touch the LLM, but the module imports it
// at eval time). Mirrors the aiGating suite.
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual('../lib/llm/dispatch');
	return { ...actual, runLlmText: vi.fn() };
});

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

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
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing'),
	),
);

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

beforeEach(() => {
	mockRole = 'owner';
});

// ============ autonomy.listRules ============

describe('operator read authz — autonomy.listRules', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.autonomy.listRules, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('allows an admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'support' }));
		});
		mockRole = 'admin';
		const rules = await t.withIdentity(identity).query(api.autonomy.listRules, {});
		expect(rules).toHaveLength(1);
	});
});

// ============ agentHealth.getCostByStep (LLM-spend consistency) ============

describe('operator read authz — agentHealth.getCostByStep', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.agentHealth.getCostByStep, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('allows an admin', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const messageId = await ctx.db.insert(
				'inboundMessages',
				createTestInboundMessage({ threadId: undefined, contactId: undefined }),
			);
			await ctx.db.insert(
				'agentActions',
				createTestAgentAction({
					inboundMessageId: messageId,
					actionType: 'classify',
					status: 'completed',
					modelUsed: 'gpt-4o-mini',
					tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
				}),
			);
		});
		mockRole = 'admin';
		const result = await t.withIdentity(identity).query(api.agentHealth.getCostByStep, {});
		expect(result.steps.length).toBeGreaterThan(0);
		expect(result.totalTokens).toBe(150);
	});
});

// ============ visualizationAgent.list ============

describe('operator read authz — visualizationAgent.list', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.visualizationAgent.list, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('allows an admin', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('visualizations', {
				title: 'Growth',
				description: 'growth chart',
				html: '<div></div>',
				pinned: false,
				createdBy: 'user',
				createdAt: now,
				updatedAt: now,
			});
		});
		mockRole = 'admin';
		const list = await t.withIdentity(identity).query(api.visualizationAgent.list, {});
		expect(list).toHaveLength(1);
	});
});
