/**
 * Integration tests for persisted email-template version history
 * (apps/api/convex/emailTemplates/versions.ts).
 *
 * The undo stack in the editor is session-scoped; these rows are the durable
 * half. What is covered here is everything the pure rules in
 * versionSnapshot.test.ts cannot see:
 *   - a save captures the POST-patch content (not the pre-patch row),
 *   - a no-op save does not grow the history, but a publish of the same bytes
 *     does — it is a different event,
 *   - a campaign-send capture goes in under the `send` trigger and the system
 *     actor,
 *   - retention evicts the OLDEST rows and keeps the newest 50,
 *   - `list` never ships snapshot bodies, `get` does (that is the restore
 *     payload), and it round-trips the exact content that was stored,
 *   - deleting the template takes its history with it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestEmailTemplate } from './factories';
import { VERSION_HISTORY_LIMIT } from '../emailTemplates/versionSnapshot';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
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
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const CONTENT_A = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'One' } }]);
const CONTENT_B = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Two' } }]);

beforeEach(() => {
	sessionMock.user = { id: 'user-alice', role: 'owner' };
});

const seedTemplate = async (
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'emailTemplates'>> =>
	t.run(async (ctx) =>
		ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: CONTENT_A, ...overrides }))
	);

const versionRows = async (t: TestConvex<typeof schema>, templateId: Id<'emailTemplates'>) =>
	t.run(async (ctx) =>
		(await ctx.db.query('emailTemplateVersions').collect()).filter(
			(row) => row.templateId === templateId
		)
	);

describe('version capture on save', () => {
	it('snapshots the post-patch content, name and subject', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			name: 'Renamed',
			subject: 'New subject',
			content: CONTENT_B,
		});

		const rows = await versionRows(t, templateId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			trigger: 'save',
			content: CONTENT_B,
			name: 'Renamed',
			subject: 'New subject',
			createdBy: 'user-alice',
		});
		expect(rows[0]?.contentBytes).toBe(CONTENT_B.length);
	});

	it('does not grow the history when a save changes nothing', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });

		expect(await versionRows(t, templateId)).toHaveLength(1);
	});

	it('captures again once the content actually changes', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_A });

		const rows = await versionRows(t, templateId);
		expect(rows.map((r) => r.content)).toEqual([CONTENT_B, CONTENT_A]);
	});
});

describe('version capture on publish and send', () => {
	it('records a publish of byte-identical content as its own version', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.publish, {
			templateId,
			htmlContent: '<p>Two</p>',
		});

		const rows = await versionRows(t, templateId);
		expect(rows.map((r) => r.trigger)).toEqual(['save', 'publish']);
		expect(rows[1]?.content).toBe(CONTENT_B);
	});

	it('captures a send snapshot under the system actor, and dedupes a repeat send', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(internal.emailTemplates.versions.captureForSend, {
			templateId,
			userId: 'system:orchestrator',
		});
		await t.mutation(internal.emailTemplates.versions.captureForSend, {
			templateId,
			userId: 'system:orchestrator',
		});

		const rows = await versionRows(t, templateId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ trigger: 'send', createdBy: 'system:orchestrator' });
	});

	it('is a no-op for a template that vanished mid-send', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) => ctx.db.delete(templateId));

		await expect(
			t.mutation(internal.emailTemplates.versions.captureForSend, {
				templateId,
				userId: 'system:orchestrator',
			})
		).resolves.toBeNull();
	});
});

describe('retention', () => {
	it('keeps the newest 50 snapshots and evicts the oldest', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		const editContent = (i: number) =>
			JSON.stringify([{ id: 'b1', type: 'text', content: { html: `edit ${i}` } }]);

		for (let i = 0; i < VERSION_HISTORY_LIMIT + 5; i++) {
			await t.mutation(api.emailTemplates.emails.update, { templateId, content: editContent(i) });
		}

		const contents = (await versionRows(t, templateId)).map((r) => r.content);
		expect(contents).toHaveLength(VERSION_HISTORY_LIMIT);
		// The five oldest edits were evicted; every later one survives, in order.
		expect(contents).toEqual(
			Array.from({ length: VERSION_HISTORY_LIMIT }, (_, i) => editContent(i + 5))
		);
	});
});

describe('read surface', () => {
	it('lists newest-first metadata without shipping snapshot bodies', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_A,
			name: 'Second',
		});

		const listed = await t.query(api.emailTemplates.versions.list, { templateId });
		expect(listed).toHaveLength(2);
		expect(listed[0]?.name).toBe('Second');
		expect(listed[0]?.contentBytes).toBe(CONTENT_A.length);
		expect(listed[0]).not.toHaveProperty('content');
		expect(listed[0]!.createdAt).toBeGreaterThanOrEqual(listed[1]!.createdAt);
	});

	it('returns the exact stored content for restore', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_B,
			subject: 'Restore me',
		});

		const [listed] = await t.query(api.emailTemplates.versions.list, { templateId });
		const version = await t.query(api.emailTemplates.versions.get, { versionId: listed!._id });

		expect(version.content).toBe(CONTENT_B);
		expect(version.subject).toBe('Restore me');
	});

	it('scopes history to its own template', async () => {
		const t = convexTest(schema, modules);
		const one = await seedTemplate(t);
		const two = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId: one, content: CONTENT_B });

		expect(await t.query(api.emailTemplates.versions.list, { templateId: one })).toHaveLength(1);
		expect(await t.query(api.emailTemplates.versions.list, { templateId: two })).toHaveLength(0);
	});
});

describe('cascade', () => {
	it('deletes the history with the template', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const survivorId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, {
			templateId: survivorId,
			content: CONTENT_B,
		});

		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		expect(await versionRows(t, templateId)).toHaveLength(0);
		expect(await versionRows(t, survivorId)).toHaveLength(1);
	});
});
