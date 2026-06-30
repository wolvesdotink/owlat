import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestEmailTemplate } from './factories';
import { assertEditableForPublishableChange } from '../emailTemplates/lifecycle';
import type { Id } from '../_generated/dataModel';
import type { Doc } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

// ============================================================================
// create
// ============================================================================

describe('Email template lifecycle — create', () => {
	it('inserts a draft row with version fields populated, fires audit log', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.create, {
			name: '  My Template  ',
			type: 'marketing',
			subject: '  Hello  ',
			previewText: ' Preview ',
			content: '[{"id":"1","type":"text"}]',
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const template = await ctx.db.get(outcome.templateId);
			expect(template?.name).toBe('My Template');
			expect(template?.subject).toBe('Hello');
			expect(template?.previewText).toBe('Preview');
			expect(template?.type).toBe('marketing');
			expect(template?.status).toBe('draft');
			expect(template?.contentBlockVersion).toBeTypeOf('number');
			expect(template?.rendererVersion).toBeTypeOf('number');
			expect(template?.defaultLanguage).toBe('en');
			expect(template?.supportedLanguages).toEqual(['en']);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === outcome.templateId));
			expect(audit?.action).toBe('email_template.created');
			expect(audit?.userId).toBe('user_1');
		});
	});

	it('linkedBlockIds populates and emits update_block_usage_counts effect', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;

		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Saved Block',
				content: '[]',
				usageCount: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.create, {
			name: 'With Blocks',
			type: 'marketing',
			linkedBlockIds: [blockId!],
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const block = await ctx.db.get(blockId!);
			expect(block?.usageCount).toBe(1);
		});
	});
});

// ============================================================================
// transition — happy path
// ============================================================================

describe('Email template lifecycle — happy path transitions', () => {
	it('draft → published patches status, htmlContent, publishedAt and audits', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'draft' })
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.emailTemplates.lifecycle.transition, {
			templateId: templateId!,
			input: {
				to: 'published',
				at,
				htmlContent: '<p>HTML</p>',
			},
			userId: 'user_pub',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.from).toBe('draft');
		expect(outcome.to).toBe('published');

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			expect(template?.status).toBe('published');
			expect(template?.htmlContent).toBe('<p>HTML</p>');
			expect(template?.publishedAt).toBe(at);
			expect(template?.updatedAt).toBe(at);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === templateId!));
			expect(audit?.action).toBe('email_template.published');
			expect(audit?.userId).toBe('user_pub');
		});
	});

	it('published → draft clears publishedAt (fixes drift with transactional)', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'published', publishedAt: Date.now() })
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.emailTemplates.lifecycle.transition, {
			templateId: templateId!,
			input: { to: 'draft', at },
			userId: 'user_unpub',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			expect(template?.status).toBe('draft');
			expect(template?.publishedAt).toBeUndefined();

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === templateId!));
			expect(audit?.action).toBe('email_template.unpublished');
		});
	});
});

// ============================================================================
// transition — idempotency
// ============================================================================

describe('Email template lifecycle — idempotency', () => {
	it('publish on already-published returns applied: recorded, no second patch', async () => {
		const t = convexTest(schema, modules);
		const originalPublishedAt = Date.now() - 100_000;
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					status: 'published',
					publishedAt: originalPublishedAt,
				})
			);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.transition, {
			templateId: templateId!,
			input: { to: 'published', at: Date.now(), htmlContent: '<p>new</p>' },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			// publishedAt must not be overwritten
			expect(template?.publishedAt).toBe(originalPublishedAt);
		});
	});

	it('draft → draft is idempotent', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'draft' })
			);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.transition, {
			templateId: templateId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');
	});
});

// ============================================================================
// transition — not found
// ============================================================================

describe('Email template lifecycle — error paths', () => {
	it('returns template_not_found for missing template', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'draft' })
			);
			await ctx.db.delete(templateId);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.transition, {
			templateId: templateId!,
			input: { to: 'published', at: Date.now(), htmlContent: '<p>x</p>' },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('template_not_found');
	});
});

// ============================================================================
// duplicate
// ============================================================================

describe('Email template lifecycle — duplicate', () => {
	it('always lands at draft with (Copy) suffix, regardless of source status', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					name: 'Original',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.duplicate, {
			templateId: templateId!,
			userId: 'user_dup',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(outcome.templateId);
			expect(copy?.name).toBe('Original (Copy)');
			expect(copy?.status).toBe('draft');

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === outcome.templateId));
			expect(audit?.action).toBe('email_template.duplicated');
		});
	});

	it('duplicate propagates linkedBlockIds via update_block_usage_counts', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Block',
				content: '[]',
				usageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					name: 'Original',
					linkedBlockIds: [blockId],
				})
			);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.duplicate, {
			templateId: templateId!,
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const block = await ctx.db.get(blockId!);
			// usage count bumps from 1 to 2 — duplicate now propagates counts.
			expect(block?.usageCount).toBe(2);
		});
	});

	it('returns template_not_found for missing template', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate()
			);
			await ctx.db.delete(templateId);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.duplicate, {
			templateId: templateId!,
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(false);
	});
});

// ============================================================================
// remove
// ============================================================================

describe('Email template lifecycle — remove', () => {
	it('deletes the row and emits email_template.deleted audit', async () => {
		const t = convexTest(schema, modules);
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ name: 'Doomed' })
			);
		});

		const outcome = await t.mutation(internal.emailTemplates.lifecycle.remove, {
			templateId: templateId!,
			userId: 'user_rm',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const template = await ctx.db.get(templateId!);
			expect(template).toBeNull();

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === templateId!));
			expect(audit?.action).toBe('email_template.deleted');
		});
	});

	it('decrements linked saved-block usageCount on remove', async () => {
		const t = convexTest(schema, modules);
		let blockId: Id<'emailBlocks'>;
		let templateId: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			blockId = await ctx.db.insert('emailBlocks', {
				name: 'Block', content: '[]', usageCount: 1,
				createdAt: Date.now(), updatedAt: Date.now(),
			});
			templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ name: 'Uses block', linkedBlockIds: [blockId] }),
			);
		});

		await t.mutation(internal.emailTemplates.lifecycle.remove, {
			templateId: templateId!,
			userId: 'user_rm',
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(blockId!))?.usageCount).toBe(0);
		});
	});
});

// ============================================================================
// assertEditableForPublishableChange (pure-function unit tests)
// ============================================================================

describe('assertEditableForPublishableChange — guard', () => {
	const baseTemplate = {
		_id: 'kk' as unknown as Id<'emailTemplates'>,
		_creationTime: 0,
		name: 'T',
		subject: 'S',
		content: '[]',
		type: 'marketing',
		status: 'draft',
		createdAt: 0,
		updatedAt: 0,
	} as unknown as Doc<'emailTemplates'>;

	it('does not throw on draft templates regardless of force', () => {
		expect(() => assertEditableForPublishableChange(baseTemplate)).not.toThrow();
		expect(() => assertEditableForPublishableChange(baseTemplate, false)).not.toThrow();
		expect(() => assertEditableForPublishableChange(baseTemplate, true)).not.toThrow();
	});

	it('throws on published templates without force', () => {
		const published = { ...baseTemplate, status: 'published' } as Doc<'emailTemplates'>;
		expect(() => assertEditableForPublishableChange(published)).toThrow(ConvexError);
		expect(() => assertEditableForPublishableChange(published, false)).toThrow(ConvexError);
	});

	it('does not throw on published templates with force: true', () => {
		const published = { ...baseTemplate, status: 'published' } as Doc<'emailTemplates'>;
		expect(() => assertEditableForPublishableChange(published, true)).not.toThrow();
	});
});
