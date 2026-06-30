/**
 * Integration tests for the Saved block (module).
 *
 * Coverage per ADR-0023:
 *   - row writes (create, update, duplicate, remove) fire audit logs
 *   - update classifies content/name/description and fires the right
 *     propagation effects
 *   - content-changed walker writes `htmlRenderState.stale: true`
 *     atomically with the content patch
 *   - name-changed walker rewrites `savedBlockRef.blockName` and does
 *     NOT touch `htmlRenderState`
 *   - description-only fires only audit_log, no propagation
 *   - `remove` strips `savedBlockRef` AND removes the `linkedBlockIds`
 *     entry on every consumer
 *   - `applyUsageCountDelta` increments/decrements correctly
 *   - the walker covers both `emailTemplates` and `transactionalEmails`
 *
 * The workpool is stubbed (the component isn't registered in convexTest)
 * so the `schedule_rerender` effect's enqueue is a no-op. We assert on
 * the walker's effect — the content patch + `htmlRenderState` — directly.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { applyUsageCountDelta } from '../emailBlocks/module';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

// Stub the workpool — the component isn't wired into convexTest and the
// 'use node' action would need the email-renderer's full module graph.
// The module-level `schedule_rerender` effect calls `enqueueAction`; we
// make it a no-op and assert on the walker's row writes directly.
vi.mock('../emailBlocks/renderingPool', async () => {
	const actual = await vi.importActual('../emailBlocks/renderingPool');
	return {
		...actual,
		rerenderBlocksPool: {
			enqueueAction: vi.fn().mockResolvedValue(undefined),
		},
		rerenderOnComplete: 'stubbed-on-complete',
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('emailBlocks/rendering.ts') &&
			!path.includes('emailBlocks/renderingPool'),
	),
);

const suppressed: Error[] = [];
const onRejection = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressed.push(err);
	} else {
		throw err;
	}
};
beforeEach(() => {
	suppressed.length = 0;
	process.on('unhandledRejection', onRejection);
});
afterEach(() => {
	process.removeListener('unhandledRejection', onRejection);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTemplateContent(
	blocks: Array<{
		id: string;
		type: string;
		content: unknown;
		savedBlockRef?: { blockId: string; groupId: string; blockName: string };
	}>,
): string {
	return JSON.stringify({ blocks });
}

function parseTemplateBlocks(contentJson: string): Array<{
	id: string;
	type: string;
	content: unknown;
	savedBlockRef?: { blockId: string; groupId: string; blockName: string };
}> {
	const parsed = JSON.parse(contentJson);
	if (Array.isArray(parsed)) return parsed;
	return parsed.blocks ?? [];
}

// ============================================================================
// create
// ============================================================================

describe('Saved block module — create', () => {
	it('inserts row at usageCount: 0 with trimmed name, fires email_block.created', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.emailBlocks.module.create, {
			name: '  My Block  ',
			description: ' Desc ',
			content: '[]',
			userId: 'user_create',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const block = await ctx.db.get(outcome.blockId);
			expect(block?.name).toBe('My Block');
			expect(block?.description).toBe('Desc');
			expect(block?.usageCount).toBe(0);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === outcome.blockId));
			expect(audit?.action).toBe('email_block.created');
			expect(audit?.userId).toBe('user_create');
			expect(audit?.resource).toBe('email_block');
		});
	});
});

// ============================================================================
// update — content / name / description classification
// ============================================================================

describe('Saved block module — update', () => {
	it('content-only update fires propagate_content + writes htmlRenderState.stale on consumers', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Saved',
				content: JSON.stringify({
					blocks: [{ id: 'b1', type: 'text', content: { text: 'old' } }],
				}),
				usageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					content: buildTemplateContent([
						{
							id: 'block-1',
							type: 'text',
							content: { text: 'old' },
							savedBlockRef: { blockId, groupId: 'g1', blockName: 'Saved' },
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);
		});

		const outcome = await t.mutation(internal.emailBlocks.module.update, {
			blockId: blockId!,
			patch: {
				content: JSON.stringify({
					blocks: [{ id: 'b1', type: 'text', content: { text: 'new' } }],
				}),
			},
			userId: 'user_upd',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.contentChanged).toBe(true);
		expect(outcome.nameChanged).toBe(false);
		expect(outcome.descriptionChanged).toBe(false);

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			expect(template?.htmlRenderState).toBeDefined();
			expect(template?.htmlRenderState?.stale).toBe(true);

			const blocks = parseTemplateBlocks(template?.content ?? '');
			// Content propagated — text is now 'new'
			const firstContent = blocks[0]?.content as { text: string } | undefined;
			expect(firstContent?.text).toBe('new');
			// savedBlockRef preserved
			expect(blocks[0]?.savedBlockRef?.blockId).toBe(blockId!);
			expect(blocks[0]?.savedBlockRef?.groupId).toBe('g1');

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.action === 'email_block.updated'));
			expect(audit?.userId).toBe('user_upd');
			expect(audit?.details?.['contentChanged']).toBe(true);
		});
	});

	it('name-only update fires propagate_name, does NOT touch htmlRenderState', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Old Name',
				content: '[]',
				usageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					content: buildTemplateContent([
						{
							id: 'block-1',
							type: 'text',
							content: { text: 'hi' },
							savedBlockRef: {
								blockId,
								groupId: 'g1',
								blockName: 'Old Name',
							},
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);
		});

		const outcome = await t.mutation(internal.emailBlocks.module.update, {
			blockId: blockId!,
			patch: { name: 'New Name' },
			userId: 'user_rename',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.nameChanged).toBe(true);
		expect(outcome.contentChanged).toBe(false);

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			// htmlRenderState NOT set — name change doesn't stale the HTML.
			expect(template?.htmlRenderState).toBeUndefined();

			const blocks = parseTemplateBlocks(template?.content ?? '');
			expect(blocks[0]?.savedBlockRef?.blockName).toBe('New Name');
		});
	});

	it('description-only update fires audit log only, no propagation', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Block',
				description: 'old desc',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					content: buildTemplateContent([
						{
							id: 'block-1',
							type: 'text',
							content: { text: 'hi' },
							savedBlockRef: { blockId, groupId: 'g1', blockName: 'Block' },
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);
		});

		const outcome = await t.mutation(internal.emailBlocks.module.update, {
			blockId: blockId!,
			patch: { description: 'new desc' },
			userId: 'user_desc',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.descriptionChanged).toBe(true);
		expect(outcome.contentChanged).toBe(false);
		expect(outcome.nameChanged).toBe(false);

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			expect(template?.htmlRenderState).toBeUndefined();

			// The audit log still fires for description-only update.
			const auditLogs = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) =>
					logs.filter((l) => l.action === 'email_block.updated'),
				);
			expect(auditLogs.length).toBe(1);
		});
	});

	it('returns block_not_found for missing block', async () => {
		const t = convexTest(schema, modules);

		const fakeId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('emailBlocks', {
				name: 'Tmp',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(internal.emailBlocks.module.update, {
			blockId: fakeId,
			patch: { name: 'X' },
			userId: 'user_x',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('block_not_found');
	});
});

// ============================================================================
// duplicate
// ============================================================================

describe('Saved block module — duplicate', () => {
	it('clones at usageCount: 0 with name suffix, fires email_block.duplicated', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Source',
				description: 'desc',
				content: '[{"id":"x","type":"text","content":{}}]',
				usageCount: 5,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.emailBlocks.module.duplicate, {
			blockId: blockId!,
			userId: 'user_dup',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const clone = await ctx.db.get(outcome.blockId);
			expect(clone?.name).toBe('Source (Copy)');
			expect(clone?.description).toBe('desc');
			expect(clone?.content).toBe('[{"id":"x","type":"text","content":{}}]');
			expect(clone?.usageCount).toBe(0);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.action === 'email_block.duplicated'));
			expect(audit?.userId).toBe('user_dup');
			expect(audit?.details?.['sourceBlockId']).toBe(blockId);
		});
	});
});

// ============================================================================
// remove — detach_all + delete
// ============================================================================

describe('Saved block module — remove', () => {
	it('detaches from every consumer (strips savedBlockRef + linkedBlockIds), deletes row, fires audit', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;
		let transactionalId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'ToDelete',
				content: '[]',
				usageCount: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					content: buildTemplateContent([
						{
							id: 'block-1',
							type: 'text',
							content: { text: 'hi' },
							savedBlockRef: { blockId, groupId: 'g1', blockName: 'ToDelete' },
						},
						{
							id: 'block-2',
							type: 'text',
							content: { text: 'other' },
						},
					]),
					linkedBlockIds: [blockId, 'other-block-id'],
				}),
			);

			transactionalId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					content: buildTemplateContent([
						{
							id: 'tx-block-1',
							type: 'text',
							content: { text: 'tx' },
							savedBlockRef: { blockId, groupId: 'tg', blockName: 'ToDelete' },
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);
		});

		const outcome = await t.mutation(internal.emailBlocks.module.remove, {
			blockId: blockId!,
			userId: 'user_del',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			// Block row gone.
			expect(await ctx.db.get(blockId!)).toBeNull();

			// Template — savedBlockRef stripped, linkedBlockIds entry removed.
			const template = await ctx.db.get(templateId!);
			expect(template?.linkedBlockIds).toEqual(['other-block-id']);
			const tBlocks = parseTemplateBlocks(template?.content ?? '');
			expect(tBlocks[0]?.savedBlockRef).toBeUndefined();
			// Other block untouched.
			expect(tBlocks[1]?.id).toBe('block-2');

			// Transactional — same shape.
			const tx = await ctx.db.get(transactionalId!);
			expect(tx?.linkedBlockIds).toEqual([]);
			const txBlocks = parseTemplateBlocks(tx?.content ?? '');
			expect(txBlocks[0]?.savedBlockRef).toBeUndefined();

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.action === 'email_block.deleted'));
			expect(audit?.userId).toBe('user_del');
		});
	});
});

// ============================================================================
// applyUsageCountDelta — cross-cutting from lifecycles
// ============================================================================

describe('Saved block module — applyUsageCountDelta', () => {
	it('increments for newly-added ids, decrements for removed (floored at zero)', async () => {
		const t = convexTest(schema, modules);
		let a: Id<'emailBlocks'>;
		let b: Id<'emailBlocks'>;
		let c: Id<'emailBlocks'>;
		await t.run(async (ctx) => {
			a = await ctx.db.insert('emailBlocks', {
				name: 'A',
				content: '[]',
				usageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			b = await ctx.db.insert('emailBlocks', {
				name: 'B',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			c = await ctx.db.insert('emailBlocks', {
				name: 'C',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Previous: [a]. Next: [b, c]. → a decrements (1 → 0), b/c increment to 1.
		await t.run(async (ctx) => {
			await applyUsageCountDelta(ctx, [a], [b, c]);
		});

		await t.run(async (ctx) => {
			const aRow = await ctx.db.get(a!);
			const bRow = await ctx.db.get(b!);
			const cRow = await ctx.db.get(c!);
			expect(aRow?.usageCount).toBe(0);
			expect(bRow?.usageCount).toBe(1);
			expect(cRow?.usageCount).toBe(1);
		});

		// Floor at 0 — second decrement of `a` stays at 0.
		await t.run(async (ctx) => {
			await applyUsageCountDelta(ctx, [a], []);
		});

		await t.run(async (ctx) => {
			const aRow = await ctx.db.get(a!);
			expect(aRow?.usageCount).toBe(0);
		});
	});

	it('routes through the public mutation', async () => {
		const t = convexTest(schema, modules);
		let id: Id<'emailBlocks'>;
		await t.run(async (ctx) => {
			id = await ctx.db.insert('emailBlocks', {
				name: 'X',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.emailBlocks.module.updateBlockUsageCounts, {
			previousIds: [],
			nextIds: [id!],
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(id!);
			expect(row?.usageCount).toBe(1);
		});
	});
});

// ============================================================================
// Walker — handles both consumer tables in one call
// ============================================================================

describe('Saved block module — walker covers both consumer tables', () => {
	it('content propagation patches a row in each consumer table', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;
		let transactionalId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Shared',
				content: JSON.stringify({
					blocks: [{ id: 'b', type: 'text', content: { text: 'old' } }],
				}),
				usageCount: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					content: buildTemplateContent([
						{
							id: 't-block',
							type: 'text',
							content: { text: 'old' },
							savedBlockRef: { blockId, groupId: 'g1', blockName: 'Shared' },
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);

			transactionalId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					content: buildTemplateContent([
						{
							id: 'tx-block',
							type: 'text',
							content: { text: 'old' },
							savedBlockRef: { blockId, groupId: 'tg', blockName: 'Shared' },
						},
					]),
					linkedBlockIds: [blockId],
				}),
			);
		});

		await t.mutation(internal.emailBlocks.module.update, {
			blockId: blockId!,
			patch: {
				content: JSON.stringify({
					blocks: [{ id: 'b', type: 'text', content: { text: 'new' } }],
				}),
			},
			userId: 'user_walker',
		});

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			const transactional = await ctx.db.get(transactionalId!);

			// Both rows had their HTML marked stale.
			expect(template?.htmlRenderState?.stale).toBe(true);
			expect(transactional?.htmlRenderState?.stale).toBe(true);

			const tBlocks = parseTemplateBlocks(template?.content ?? '');
			const txBlocks = parseTemplateBlocks(transactional?.content ?? '');
			const tContent = tBlocks[0]?.content as { text: string } | undefined;
			const txContent = txBlocks[0]?.content as { text: string } | undefined;
			expect(tContent?.text).toBe('new');
			expect(txContent?.text).toBe('new');
		});
	});
});
