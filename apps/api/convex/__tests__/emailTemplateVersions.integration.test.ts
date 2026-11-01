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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestEmailTemplate } from './factories';
import { AUTOSAVE_VERSION_SCAN, VERSION_HISTORY_LIMIT } from '../emailTemplates/versionSnapshot';
import { SOFT_DELETE_RETENTION_MS } from '../lib/softDelete';

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
			!path.includes('files/processing') &&
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

describe('version capture on autosave', () => {
	const CONTENT_C = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Three' } }]);
	const audits = (t: TestConvex<typeof schema>) =>
		t.run(async (ctx) =>
			(await ctx.db.query('auditLogs').collect()).filter(
				(row) => row.action === 'email_template.updated'
			)
		);

	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps one row and one audit entry per person and window', async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_B,
			autosave: true,
		});
		vi.setSystemTime(Date.UTC(2026, 9, 24, 10, 4, 0));
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_C,
			autosave: true,
		});

		let rows = await versionRows(t, templateId);
		expect(rows.map((r) => r.content)).toEqual([CONTENT_C]);
		expect(await audits(t)).toHaveLength(1);

		// A new window starts a new row (and the burst is recorded again).
		vi.setSystemTime(Date.UTC(2026, 9, 24, 10, 12, 0));
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_A,
			autosave: true,
		});
		rows = await versionRows(t, templateId);
		expect(rows.map((r) => r.content)).toEqual([CONTENT_C, CONTENT_A]);
		expect(await audits(t)).toHaveLength(2);
	});

	it("never replaces another person's row or a publish", async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_B,
			autosave: true,
		});
		sessionMock.user = { id: 'user-bob', role: 'owner' };
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_C,
			autosave: true,
		});
		await t.mutation(api.emailTemplates.emails.publish, { templateId });
		await t.mutation(api.emailTemplates.emails.unpublish, { templateId });
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT_A,
			autosave: true,
		});

		const rows = await versionRows(t, templateId);
		expect(rows.map((r) => [r.trigger, r.createdBy])).toEqual([
			['save', 'user-alice'],
			['save', 'user-bob'],
			['publish', 'user-bob'],
			['save', 'user-bob'],
		]);
	});

	it('keeps one row per person in the window while co-editors alternate', async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const save = async (userId: string, content: string, second: number) => {
			sessionMock.user = { id: userId, role: 'owner' };
			vi.setSystemTime(Date.UTC(2026, 9, 24, 10, 0, second));
			await t.mutation(api.emailTemplates.emails.update, { templateId, content, autosave: true });
		};

		await save('user-alice', CONTENT_B, 0);
		await save('user-bob', CONTENT_C, 2);
		await save('user-alice', CONTENT_A, 4);
		await save('user-bob', CONTENT_B, 6);

		const rows = await versionRows(t, templateId);
		expect(rows.map((r) => [r.createdBy, r.content])).toEqual([
			['user-alice', CONTENT_A],
			['user-bob', CONTENT_B],
		]);
		expect(await audits(t)).toHaveLength(2);
	});

	it("adds a row when the same person's earlier save lies past the bounded lookup", async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const save = async (userId: string, i: number) => {
			sessionMock.user = { id: userId, role: 'owner' };
			vi.setSystemTime(Date.UTC(2026, 9, 24, 10, 0, i));
			const content = JSON.stringify([{ id: 'b1', type: 'text', content: { html: `v${i}` } }]);
			await t.mutation(api.emailTemplates.emails.update, { templateId, content, autosave: true });
		};

		// Alice, then more co-editors than the lookup reads, then Alice again.
		await save('user-alice', 0);
		for (let i = 1; i <= AUTOSAVE_VERSION_SCAN; i++) await save(`user-${i}`, i);
		await save('user-alice', AUTOSAVE_VERSION_SCAN + 1);

		// Her first row is beyond the newest rows read: the save keeps it and adds one.
		const alice = (await versionRows(t, templateId)).filter((r) => r.createdBy === 'user-alice');
		expect(alice).toHaveLength(2);
	});

	it('leaves neither a history row nor an audit entry when the save is refused', async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 4 });

		await expect(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				content: CONTENT_B,
				autosave: true,
				expectedContentRevision: 3,
			})
		).rejects.toThrow();

		expect(await versionRows(t, templateId)).toEqual([]);
		expect(await audits(t)).toEqual([]);
	});

	it('leaves a save without the flag as its own row', async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 24, 10, 0, 0), toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_C });

		expect((await versionRows(t, templateId)).map((r) => r.content)).toEqual([
			CONTENT_B,
			CONTENT_C,
		]);
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
	it('keeps the history while the template is in Recently deleted and purges it with the template', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const survivorId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await t.mutation(api.emailTemplates.emails.update, {
			templateId: survivorId,
			content: CONTENT_B,
		});

		await t.mutation(api.emailTemplates.emails.remove, { templateId });
		expect(await versionRows(t, templateId)).toHaveLength(1);

		await t.mutation(internal.marketing.recentlyDeleted.purgeExpired, {
			now: Date.now() + SOFT_DELETE_RETENTION_MS + 1,
		});

		expect(await t.run(async (ctx) => ctx.db.get(templateId))).toBeNull();
		expect(await versionRows(t, templateId)).toHaveLength(0);
		expect(await versionRows(t, survivorId)).toHaveLength(1);
	});
});

describe('latest send', () => {
	const send = (t: TestConvex<typeof schema>, templateId: Id<'emailTemplates'>) =>
		t.mutation(internal.emailTemplates.versions.captureForSend, {
			templateId,
			userId: 'system:orchestrator',
		});

	it('is null for a template that was never sent', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });

		expect(await t.query(api.emailTemplates.versions.latestSend, { templateId })).toBeNull();
	});

	it('returns the newest send, not a newer save, and says whether the template still matches it', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await send(t, templateId);

		const fresh = await t.query(api.emailTemplates.versions.latestSend, { templateId });
		expect(fresh?.unchanged).toBe(true);
		expect(fresh).not.toHaveProperty('version.content');

		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		const edited = await t.query(api.emailTemplates.versions.latestSend, { templateId });
		expect(edited?.version._id).toBe(fresh?.version._id);
		expect(edited?.unchanged).toBe(false);
		const snapshot = await t.query(api.emailTemplates.versions.get, {
			versionId: edited!.version._id,
		});
		expect(snapshot).toMatchObject({ trigger: 'send', content: CONTENT_A });

		await t.mutation(api.emailTemplates.emails.update, { templateId, subject: 'Other subject' });
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_A });
		const subjectOnly = await t.query(api.emailTemplates.versions.latestSend, { templateId });
		expect(subjectOnly?.unchanged).toBe(false);
	});

	it('picks the newest of several sends', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await send(t, templateId);
		await t.mutation(api.emailTemplates.emails.update, { templateId, content: CONTENT_B });
		await send(t, templateId);

		const latest = await t.query(api.emailTemplates.versions.latestSend, { templateId });
		const snapshot = await t.query(api.emailTemplates.versions.get, {
			versionId: latest!.version._id,
		});
		expect(snapshot.content).toBe(CONTENT_B);
		expect(latest?.unchanged).toBe(true);
	});

	it('dates a repeated send of an unchanged template by the newest send', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const first = Date.UTC(2026, 9, 1, 9);
			const second = Date.UTC(2026, 9, 24, 9);
			vi.setSystemTime(first);
			const t = convexTest(schema, modules);
			const templateId = await seedTemplate(t);
			await send(t, templateId);
			vi.setSystemTime(second);
			await send(t, templateId);

			const latest = await t.query(api.emailTemplates.versions.latestSend, { templateId });
			expect(latest?.version.createdAt).toBe(first);
			expect(latest?.version.sentAt).toBe(second);
			expect(latest?.unchanged).toBe(true);
			// Still one row: the repeat moved the send date, not the snapshot.
			const rows = await versionRows(t, templateId);
			expect(rows.filter((row) => row.trigger === 'send')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a new send snapshot when only the preview text changed', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await send(t, templateId);
		// A writer that records no save in between (the translation paths patch
		// the template directly), so the two sends are consecutive.
		await t.run(async (ctx) => ctx.db.patch(templateId, { previewText: 'New peek' }));
		await send(t, templateId);

		const latest = await t.query(api.emailTemplates.versions.latestSend, { templateId });
		const snapshot = await t.query(api.emailTemplates.versions.get, {
			versionId: latest!.version._id,
		});
		expect(snapshot.previewText).toBe('New peek');
		expect(latest?.unchanged).toBe(true);
		const rows = await versionRows(t, templateId);
		expect(rows.filter((row) => row.trigger === 'send')).toHaveLength(2);
	});

	it('is null once retention evicted the send snapshot', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await send(t, templateId);
		for (let i = 0; i < VERSION_HISTORY_LIMIT; i++) {
			await t.mutation(api.emailTemplates.emails.update, {
				templateId,
				content: JSON.stringify([{ id: 'b1', type: 'text', content: { html: `edit ${i}` } }]),
			});
		}

		expect(await t.query(api.emailTemplates.versions.latestSend, { templateId })).toBeNull();
	});

	it('is null for a template in Recently deleted', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await send(t, templateId);
		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		expect(await t.query(api.emailTemplates.versions.latestSend, { templateId })).toBeNull();
	});
});
