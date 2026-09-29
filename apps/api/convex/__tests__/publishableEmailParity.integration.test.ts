/**
 * Parity tests for the two publishable-email tables, `emailTemplates` and
 * `transactionalEmails`. Both run their publish, duplicate, delete and update
 * rules through `lib/publishableEmail.ts`; the same scenarios run against each
 * table through a small driver so a fix on one side cannot silently miss the
 * other again (issue #862 finding 2).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

const SESSION_USER = 'user-parity';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-parity', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-parity'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user-parity', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user-parity', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

type T = TestConvex<typeof schema>;
type Table = 'emailTemplates' | 'transactionalEmails';
type RowId = Id<Table>;

interface EditArgs {
	name?: string;
	subject?: string;
	defaultLanguage?: string;
	translations?: string;
}

/** One table's public surface, reduced to what the parity scenarios need. */
interface Driver {
	table: Table;
	/** Audit `resource` the table's rows are recorded under. */
	resource: 'email_template' | 'transactional_email';
	/** Table-only columns a duplicate must keep, and the values it must reset. */
	duplicateKeeps: Record<string, unknown>;
	duplicateResets: Record<string, unknown>;
	seed: (t: T, overrides?: Record<string, unknown>) => Promise<RowId>;
	create: (t: T) => Promise<RowId>;
	update: (t: T, id: RowId, args: EditArgs) => Promise<unknown>;
	publish: (t: T, id: RowId, htmlContent?: string) => Promise<unknown>;
	unpublish: (t: T, id: RowId) => Promise<unknown>;
	duplicate: (t: T, id: RowId) => Promise<RowId>;
	remove: (t: T, id: RowId) => Promise<unknown>;
}

const asTemplate = (id: RowId) => id as Id<'emailTemplates'>;
const asTransactional = (id: RowId) => id as Id<'transactionalEmails'>;

let slugCounter = 0;

const drivers: Driver[] = [
	{
		table: 'emailTemplates',
		resource: 'email_template',
		duplicateKeeps: {},
		duplicateResets: {},
		seed: (t, overrides = {}) =>
			t.run((ctx) =>
				ctx.db.insert(
					'emailTemplates',
					createTestEmailTemplate({
						subject: 'Hello',
						htmlContent: '<p>Row HTML</p>',
						...overrides,
					})
				)
			),
		create: (t) =>
			t.mutation(api.emailTemplates.emails.create, { name: 'Parity', type: 'marketing' }),
		update: (t, id, args) =>
			t.mutation(api.emailTemplates.emails.update, { templateId: asTemplate(id), ...args }),
		publish: (t, id, htmlContent) =>
			t.mutation(api.emailTemplates.emails.publish, { templateId: asTemplate(id), htmlContent }),
		unpublish: (t, id) =>
			t.mutation(api.emailTemplates.emails.unpublish, { templateId: asTemplate(id) }),
		duplicate: (t, id) =>
			t.mutation(api.emailTemplates.emails.duplicate, { templateId: asTemplate(id) }),
		remove: (t, id) => t.mutation(api.emailTemplates.emails.remove, { templateId: asTemplate(id) }),
	},
	{
		table: 'transactionalEmails',
		resource: 'transactional_email',
		duplicateKeeps: {
			attachments: JSON.stringify([{ id: 'a1', filename: 'invoice.pdf' }]),
			dataVariablesSchema: { orderId: 'string' },
		},
		duplicateResets: { sendCount: 7 },
		seed: (t, overrides = {}) =>
			t.run((ctx) =>
				ctx.db.insert(
					'transactionalEmails',
					createTestTransactionalEmail({
						slug: `parity-${++slugCounter}`,
						subject: 'Hello',
						htmlContent: '<p>Row HTML</p>',
						...overrides,
					})
				)
			),
		create: (t) =>
			t.mutation(api.transactional.emails.create, {
				name: 'Parity',
				slug: `parity-created-${++slugCounter}`,
			}),
		update: (t, id, args) =>
			t.mutation(api.transactional.emails.update, { id: asTransactional(id), ...args }),
		publish: (t, id, htmlContent) =>
			t.mutation(api.transactional.emails.publish, { id: asTransactional(id), htmlContent }),
		unpublish: (t, id) =>
			t.mutation(api.transactional.emails.unpublish, { id: asTransactional(id) }),
		duplicate: (t, id) =>
			t.mutation(api.transactional.emails.duplicate, { id: asTransactional(id) }),
		remove: (t, id) => t.mutation(api.transactional.emails.remove, { id: asTransactional(id) }),
	},
];

/** Resolve a rejected mutation to its Operation error payload. */
async function operationError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<{ category: string; data?: Record<string, Value> }>).data;
}

const getRow = (t: T, id: RowId) => t.run((ctx) => ctx.db.get(id));

const seedBlock = (t: T, usageCount: number) =>
	t.run((ctx) =>
		ctx.db.insert('emailBlocks', {
			name: 'Footer',
			content: '[]',
			usageCount,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);

describe.each(drivers)('publishable email parity — $table', (driver) => {
	it('refuses to publish while a saved-block rerender is pending', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, { htmlRenderState: { stale: true, failureCount: 0 } });

		const data = await operationError(driver.publish(t, id, '<p>Client HTML</p>'));

		expect(data.category).toBe('invalid_state');
		expect(data.data).toMatchObject({ reason: 'html_render_pending' });
		expect((await getRow(t, id))?.status).toBe('draft');
	});

	it("publishes a render of the row's blocks, not the client's or the row's HTML", async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t);

		await driver.publish(t, id, '<p>Stale client HTML</p>');

		const row = await getRow(t, id);
		expect(row?.status).toBe('published');
		expect(row?.htmlContent).toContain('<!DOCTYPE html>');
		expect(row?.htmlContent).not.toContain('Stale client HTML');
		expect(row?.htmlContent).not.toContain('Row HTML');
	});

	it('duplicates every content column and resets publish state and counters', async () => {
		const t = convexTest(schema, modules);
		const htmlTranslations = JSON.stringify({ de: { htmlContent: '<p>Hallo</p>' } });
		const sourceId = await driver.seed(t, {
			status: 'published',
			publishedAt: Date.now(),
			contentRevision: 9,
			plainTextContent: 'Hand-written text',
			plainTextOverride: 'Hand-written text',
			showUnsubscribe: true,
			htmlTranslations,
			htmlRenderState: { stale: false },
			...driver.duplicateKeeps,
			...driver.duplicateResets,
		});

		const copyId = await driver.duplicate(t, sourceId);

		const copy = (await getRow(t, copyId)) as Record<string, unknown> | null;
		expect(copy).toMatchObject({
			status: 'draft',
			plainTextContent: 'Hand-written text',
			plainTextOverride: 'Hand-written text',
			showUnsubscribe: true,
			...driver.duplicateKeeps,
		});
		// The copy's HTML is rendered from its blocks, not copied.
		expect(copy?.['htmlContent']).toContain('<!DOCTYPE html>');
		expect(copy?.['htmlContent']).not.toContain('Row HTML');
		expect(copy?.['publishedAt']).toBeUndefined();
		expect(copy?.['contentRevision']).toBeUndefined();
		expect(copy?.['htmlRenderState']).toBeUndefined();
		for (const key of Object.keys(driver.duplicateResets)) {
			expect(copy?.[key]).toBeUndefined();
		}
	});

	it('renders the copy of a row whose rerender is pending, so the copy is current', async () => {
		const t = convexTest(schema, modules);
		const sourceId = await driver.seed(t, { htmlRenderState: { stale: true, failureCount: 0 } });

		const copyId = await driver.duplicate(t, sourceId);

		const copy = await getRow(t, copyId);
		expect(copy?.htmlRenderState).toBeUndefined();
		expect(copy?.htmlContent).not.toContain('Row HTML');
		await driver.publish(t, copyId);
		expect((await getRow(t, copyId))?.status).not.toBe('draft');
	});

	it("decrements the linked saved block's usage count on delete", async () => {
		const t = convexTest(schema, modules);
		const blockId = await seedBlock(t, 2);
		const id = await driver.seed(t, { linkedBlockIds: [blockId] });

		await driver.remove(t, id);

		expect(await getRow(t, id)).toBeNull();
		expect((await t.run((ctx) => ctx.db.get(blockId)))?.usageCount).toBe(1);
	});

	it('records the session user on every audit row', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.create(t);
		await driver.update(t, id, { name: '  Renamed  ', subject: '  Hi  ' });
		await driver.publish(t, id, '<p>First render</p>');
		await driver.unpublish(t, id);
		const copyId = await driver.duplicate(t, id);
		await driver.remove(t, copyId);

		const rows = await t.run(async (ctx) =>
			(await ctx.db.query('auditLogs').collect()).filter((r) => r.resource === driver.resource)
		);
		const actions = rows.map((r) => r.action.split('.')[1]);
		expect(actions).toEqual(
			expect.arrayContaining([
				'created',
				'updated',
				'published',
				'unpublished',
				'duplicated',
				'deleted',
			])
		);
		expect(rows.every((r) => r.userId === SESSION_USER)).toBe(true);

		const updated = rows.find((r) => r.action.endsWith('.updated'));
		expect(String(updated?.details?.['changedFields'])).toContain('name');
		const row = await getRow(t, id);
		expect(row?.name).toBe('Renamed');
		expect(row?.subject).toBe('Hi');
	});

	it('refuses an update that relabels the default language of a row with translations', async () => {
		const t = convexTest(schema, modules);
		const translations = JSON.stringify({ de: { subject: 'Hallo', blocks: {} } });
		const id = await driver.seed(t, { defaultLanguage: 'en', translations });

		const data = await operationError(driver.update(t, id, { defaultLanguage: 'de' }));

		expect(data.category).toBe('invalid_state');
		expect(data.data).toMatchObject({ reason: 'use_set_default_language' });
		expect((await getRow(t, id))?.defaultLanguage).toBe('en');
	});

	it('accepts the stored default language, and a relabel of a row without translations', async () => {
		const t = convexTest(schema, modules);
		const translations = JSON.stringify({ de: { subject: 'Hallo', blocks: {} } });
		const withOverlays = await driver.seed(t, { defaultLanguage: 'en', translations });
		const withoutOverlays = await driver.seed(t, { defaultLanguage: 'en' });

		await driver.update(t, withOverlays, { defaultLanguage: 'en', subject: 'Saved' });
		await driver.update(t, withoutOverlays, { defaultLanguage: 'fr' });

		expect((await getRow(t, withOverlays))?.subject).toBe('Saved');
		expect((await getRow(t, withoutOverlays))?.defaultLanguage).toBe('fr');
	});
});
