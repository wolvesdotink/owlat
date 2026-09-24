/**
 * Integration tests for the editor-content revision (lib/contentRevision.ts):
 * the concurrent-writer check on the two publishable-email `update` mutations.
 *
 *   - a save built on the current revision lands and advances it by one
 *   - a save built on an older revision is refused with `conflict` and writes
 *     nothing
 *   - omitting the expected revision keeps the old unconditional write
 *   - translation writers advance the revision (the editor renders translated
 *     HTML from the overlays), bookkeeping writers do not
 *   - `update` returns the revision it stored, and a content + HTML write
 *     clears a pending saved-block rerender flag
 *   - `publish` takes the same optional guard
 *   - the saved-block rerender pool's HTML patch refuses a row that moved
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const CONTENT = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Hello' } }]);

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ status: 'draft', content: CONTENT, ...overrides })
		)
	);

const seedTransactional = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ status: 'draft', content: CONTENT, ...overrides })
		)
	);

/** Resolve a rejected mutation to its Operation error payload. */
async function operationError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<{ category: string; data?: Record<string, Value> }>).data;
}

describe('emailTemplates.update — content revision', () => {
	it('lands a save built on the current revision and advances it by one', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 4 });

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			subject: 'Saved',
			expectedContentRevision: 4,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.subject).toBe('Saved');
		expect(row?.contentRevision).toBe(5);
	});

	it('refuses a save built on an older revision with a typed conflict and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { subject: 'Theirs', contentRevision: 5 });

		const data = await operationError(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				subject: 'Mine',
				content: '[]',
				htmlContent: '<p>stale</p>',
				htmlTranslations: '{}',
				expectedContentRevision: 4,
			})
		);

		expect(data.category).toBe('conflict');
		expect(data.data).toMatchObject({
			reason: 'stale_content_revision',
			expectedRevision: 4,
			currentRevision: 5,
			messageKey: 'shared.useEmailEditorBridge.staleRevision',
		});
		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.subject).toBe('Theirs');
		expect(row?.content).toBe(CONTENT);
		expect(row?.contentRevision).toBe(5);
	});

	it('treats a row written before the field existed as revision 0', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			subject: 'First guarded save',
			expectedContentRevision: 0,
		});

		expect((await t.run((ctx) => ctx.db.get(templateId)))?.contentRevision).toBe(1);
	});

	it('returns the revision it stored', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 6 });

		const result = await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			subject: 'Saved',
			expectedContentRevision: 6,
		});

		expect(result).toEqual({ templateId, contentRevision: 7 });
	});

	it('clears a pending rerender flag when blocks and their HTML land together', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			contentRevision: 2,
			htmlRenderState: { stale: true, failureCount: 1 },
		});

		// A subject-only write leaves the HTML as stale as it was.
		await t.mutation(api.emailTemplates.emails.update, { templateId, subject: 'Just the subject' });
		expect((await t.run((ctx) => ctx.db.get(templateId)))?.htmlRenderState?.stale).toBe(true);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT,
			htmlContent: '<p>Hello</p>',
			expectedContentRevision: 3,
		});
		expect((await t.run((ctx) => ctx.db.get(templateId)))?.htmlRenderState).toEqual({
			stale: false,
		});
	});

	it('still writes unconditionally when no revision is named', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 9 });

		await t.mutation(api.emailTemplates.emails.update, { templateId, subject: 'Legacy client' });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.subject).toBe('Legacy client');
		expect(row?.contentRevision).toBe(10);
	});

	it('makes an editor draft stale when a translation is edited in the meantime', async () => {
		const t = convexTest(schema, modules);
		const templateId: Id<'emailTemplates'> = await seedTemplate(t, {
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		// The editor opened the row at revision 0; the translations page adds and
		// edits German meanwhile.
		await t.mutation(api.emailTemplates.i18n.addTranslation, { templateId, language: 'de' });
		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId,
			language: 'de',
			blocks: JSON.stringify({ b1: { html: 'Hallo' } }),
		});
		expect((await t.run((ctx) => ctx.db.get(templateId)))?.contentRevision).toBe(2);

		const data = await operationError(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				htmlTranslations: '{}',
				expectedContentRevision: 0,
			})
		);
		expect(data.category).toBe('conflict');
	});
});

describe('transactional.emails.update — content revision', () => {
	it('lands a current save and refuses a stale one', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, { contentRevision: 2 });

		await t.mutation(api.transactional.emails.update, {
			id,
			subject: 'Saved',
			expectedContentRevision: 2,
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.contentRevision).toBe(3);

		const data = await operationError(
			t.mutation(api.transactional.emails.update, {
				id,
				subject: 'From another tab',
				expectedContentRevision: 2,
			})
		);
		expect(data.category).toBe('conflict');
		expect((await t.run((ctx) => ctx.db.get(id)))?.subject).toBe('Saved');
	});

	it('returns the revision it stored', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, { contentRevision: 4 });

		const result = await t.mutation(api.transactional.emails.update, {
			id,
			content: CONTENT,
			htmlContent: '<p>Hello</p>',
			expectedContentRevision: 4,
		});

		expect(result).toEqual({ id, contentRevision: 5 });
	});

	it('does not make the draft stale when the editor adds a data variable', async () => {
		// The transactional editor writes the variable schema mid-edit; that must
		// not turn the next save into a conflict.
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, { contentRevision: 1 });

		await t.mutation(api.transactional.emails.updateSchema, {
			id,
			dataVariablesSchema: { orderNumber: 'string' },
		});
		await t.mutation(api.transactional.emails.update, {
			id,
			subject: 'Saved after adding a variable',
			expectedContentRevision: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.subject).toBe('Saved after adding a variable');
		expect(row?.contentRevision).toBe(2);
	});

	it('advances the revision on translation edits', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, {
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		await t.mutation(api.transactional.translations.addTranslation, { id, language: 'de' });
		await t.mutation(api.transactional.translations.updateTranslation, {
			id,
			language: 'de',
			subject: 'Hallo',
		});
		await t.mutation(api.transactional.translations.removeTranslation, { id, language: 'de' });

		expect((await t.run((ctx) => ctx.db.get(id)))?.contentRevision).toBe(3);
	});
});

describe('publish — content revision', () => {
	it('publishes a template whose revision still matches, and refuses one that moved', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 3 });

		const data = await operationError(
			t.mutation(api.emailTemplates.emails.publish, {
				templateId,
				htmlContent: '<p>Rendered from revision 2</p>',
				expectedContentRevision: 2,
			})
		);
		expect(data.category).toBe('conflict');
		expect(data.data).toMatchObject({
			reason: 'stale_content_revision',
			currentRevision: 3,
			messageKey: 'shared.useEmailEditorBridge.stalePublish',
		});
		expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('draft');

		await t.mutation(api.emailTemplates.emails.publish, {
			templateId,
			htmlContent: '<p>Rendered from revision 3</p>',
			expectedContentRevision: 3,
		});
		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('published');
		expect(row?.htmlContent).toBe('<p>Rendered from revision 3</p>');
	});

	it('keeps publishing without a revision for callers that do not send one', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { contentRevision: 8 });

		await t.mutation(api.emailTemplates.emails.publish, { templateId, htmlContent: '<p>Hi</p>' });

		expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('published');
	});

	it('refuses a transactional publish rendered from an older revision', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, { contentRevision: 5 });

		const data = await operationError(
			t.mutation(api.transactional.emails.publish, {
				id,
				htmlContent: '<p>Old render</p>',
				expectedContentRevision: 4,
			})
		);

		expect(data.category).toBe('conflict');
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('draft');
	});
});

describe('saved-block rerender patch — content revision', () => {
	const rendered = { htmlContent: '<p>Rerendered</p>', plainTextContent: 'Rerendered' };

	it('applies the HTML when the row is still at the revision it was rendered from', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			contentRevision: 4,
			htmlRenderState: { stale: true, failureCount: 0 },
		});

		const outcome = await t.mutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
			templateId,
			...rendered,
			expectedContentRevision: 4,
		});

		expect(outcome).toBe('applied');
		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.htmlContent).toBe('<p>Rerendered</p>');
		expect(row?.htmlRenderState).toEqual({ stale: false });
	});

	it('leaves an editor save that landed after the render untouched', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			contentRevision: 4,
			htmlRenderState: { stale: true, failureCount: 0 },
		});
		// The editor saves blocks + HTML built on revision 4 while the action renders.
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT,
			htmlContent: '<p>Editor save</p>',
			htmlTranslations: '{"de":{"htmlContent":"<p>Hallo</p>","subject":"Hallo"}}',
			expectedContentRevision: 4,
		});

		const outcome = await t.mutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
			templateId,
			...rendered,
			htmlTranslations: '{}',
			expectedContentRevision: 4,
		});

		expect(outcome).toBe('superseded');
		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.htmlContent).toBe('<p>Editor save</p>');
		expect(row?.htmlTranslations).toContain('Hallo');
	});

	it('asks for a fresh render when the row moved but its HTML is still stale', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTransactional(t, {
			contentRevision: 2,
			htmlContent: '<p>Before</p>',
			htmlRenderState: { stale: true, failureCount: 0 },
		});
		// A translation edit moves the row without re-rendering its HTML.
		await t.run((ctx) => ctx.db.patch(id, { contentRevision: 3 }));

		const outcome = await t.mutation(internal.emailBlocks.renderingPool.patchTransactionalHtml, {
			emailId: id,
			...rendered,
			expectedContentRevision: 2,
		});

		expect(outcome).toBe('moved');
		expect((await t.run((ctx) => ctx.db.get(id)))?.htmlContent).toBe('<p>Before</p>');
	});
});
