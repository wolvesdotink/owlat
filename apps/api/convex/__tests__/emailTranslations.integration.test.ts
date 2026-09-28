/**
 * Translation mutations for both publishable-email tables, `emailTemplates`
 * (`emailTemplates/i18n.ts`) and `transactionalEmails`
 * (`transactional/translations.ts`). Both are shells around the `*Patch`
 * helpers in `lib/emailTranslations.ts`; the same scenarios run against each
 * table through a small driver so a translation fix cannot reach only one side
 * (issue #862 finding 6). Transactional emails carry no previewText, so their
 * cases assert it is never written.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import {
	createTestEmailTemplate,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from './factories';

// Mutable acting role. The builder floor (`getMutationContext`) threads it as
// the session; `requireOrgPermission` runs the real permission check against it.
const sessionMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const requirePermission: typeof SessionOrganization.requirePermission = actual.requirePermission;
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: 'user-i18n',
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: 'user-i18n',
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-i18n'),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				requirePermission(
					actual.hasPermission(
						sessionMock.role,
						permission as Parameters<typeof actual.hasPermission>[1]
					),
					message
				);
				return { userId: 'user-i18n', role: sessionMock.role };
			}),
	};
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	sessionMock.role = 'owner';
});

type T = TestConvex<typeof schema>;
type Table = 'emailTemplates' | 'transactionalEmails';
type RowId = Id<Table>;

interface UpdateArgs {
	language: string;
	subject?: string;
	previewText?: string;
	blocks?: string;
}

interface Driver {
	table: Table;
	hasPreviewText: boolean;
	seed: (t: T, overrides?: Record<string, unknown>) => Promise<RowId>;
	add: (t: T, id: RowId, language: string) => Promise<unknown>;
	update: (t: T, id: RowId, args: UpdateArgs) => Promise<unknown>;
	remove: (t: T, id: RowId, language: string) => Promise<unknown>;
	setDefault: (t: T, id: RowId, language: string, force?: boolean) => Promise<unknown>;
}

const asTemplate = (id: RowId) => id as Id<'emailTemplates'>;
const asTransactional = (id: RowId) => id as Id<'transactionalEmails'>;

const CONTENT_EN = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: 'Hello world' } },
	{ id: 'b2', type: 'button', content: { text: 'Click me', url: 'https://x' } },
]);

const DE_BLOCKS = { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick mich' } };

let slugCounter = 0;

const drivers: Driver[] = [
	{
		table: 'emailTemplates',
		hasPreviewText: true,
		seed: (t, overrides = {}) =>
			t.run((ctx) =>
				ctx.db.insert(
					'emailTemplates',
					createTestEmailTemplate({
						subject: 'English subject',
						previewText: 'English preview',
						content: CONTENT_EN,
						defaultLanguage: 'en',
						supportedLanguages: ['en'],
						contentRevision: 3,
						...overrides,
					})
				)
			),
		add: (t, id, language) =>
			t.mutation(api.emailTemplates.i18n.addTranslation, { templateId: asTemplate(id), language }),
		update: (t, id, args) =>
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId: asTemplate(id),
				...args,
			}),
		remove: (t, id, language) =>
			t.mutation(api.emailTemplates.i18n.removeTranslation, {
				templateId: asTemplate(id),
				language,
			}),
		setDefault: (t, id, language, forceWhilePublished) =>
			t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
				templateId: asTemplate(id),
				language,
				forceWhilePublished,
			}),
	},
	{
		table: 'transactionalEmails',
		hasPreviewText: false,
		seed: (t, overrides = {}) =>
			t.run((ctx) =>
				ctx.db.insert(
					'transactionalEmails',
					createTestTransactionalEmail({
						slug: `i18n-${++slugCounter}`,
						subject: 'English subject',
						content: CONTENT_EN,
						defaultLanguage: 'en',
						supportedLanguages: ['en'],
						contentRevision: 3,
						...overrides,
					})
				)
			),
		add: (t, id, language) =>
			t.mutation(api.transactional.translations.addTranslation, {
				id: asTransactional(id),
				language,
			}),
		// The transactional mutation takes no previewText argument.
		update: (t, id, { previewText: _previewText, ...args }) =>
			t.mutation(api.transactional.translations.updateTranslation, {
				id: asTransactional(id),
				...args,
			}),
		remove: (t, id, language) =>
			t.mutation(api.transactional.translations.removeTranslation, {
				id: asTransactional(id),
				language,
			}),
		setDefault: (t, id, language, forceWhilePublished) =>
			t.mutation(api.transactional.translations.setDefaultLanguage, {
				id: asTransactional(id),
				language,
				forceWhilePublished,
			}),
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

function withGerman(hasPreviewText: boolean, extra: Record<string, unknown> = {}) {
	return {
		supportedLanguages: ['en', 'de'],
		translations: JSON.stringify({
			de: {
				subject: 'Deutscher Betreff',
				...(hasPreviewText ? { previewText: 'Deutsche Vorschau' } : {}),
				blocks: DE_BLOCKS,
			},
		}),
		...extra,
	};
}

describe.each(drivers)('translation mutations on $table', (driver) => {
	const read = (t: T, id: RowId) => t.run((ctx) => ctx.db.get(id));
	const overlays = (row: { translations?: string } | null) =>
		JSON.parse(row?.translations ?? '{}') as Record<string, Record<string, unknown>>;

	it('addTranslation seeds the overlay from the default text and advances the revision', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t);

		await driver.add(t, id, 'de');

		const row = await read(t, id);
		expect(row?.supportedLanguages).toEqual(['en', 'de']);
		expect(row?.contentRevision).toBe(4);
		const de = overlays(row)['de']!;
		expect(de['subject']).toBe('English subject');
		expect(de['blocks']).toEqual({ b1: { html: 'Hello world' }, b2: { buttonText: 'Click me' } });
		if (driver.hasPreviewText) {
			expect(de['previewText']).toBe('English preview');
		} else {
			expect(de).not.toHaveProperty('previewText');
		}
	});

	it('updateTranslation on the default language trims the main columns only', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText));
		const before = await read(t, id);

		await driver.update(t, id, { language: 'en', subject: '  New  ', previewText: '  Pre  ' });

		const row = await read(t, id);
		expect(row?.subject).toBe('New');
		expect(row?.contentRevision).toBe(4);
		expect(row?.translations).toBe(before?.translations);
		if (driver.hasPreviewText) {
			expect(row).toHaveProperty('previewText', 'Pre');
		} else {
			expect(row).not.toHaveProperty('previewText');
		}
	});

	it('updateTranslation on another language replaces the overlay text', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText));

		await driver.update(t, id, {
			language: 'de',
			subject: ' Willkommen ',
			previewText: ' Neu ',
			blocks: JSON.stringify({ b1: { html: 'Neu' } }),
		});

		const row = await read(t, id);
		expect(row?.subject).toBe('English subject');
		expect(row?.contentRevision).toBe(4);
		const de = overlays(row)['de']!;
		expect(de['subject']).toBe('Willkommen');
		expect(de['blocks']).toEqual({ b1: { html: 'Neu' } });
		if (driver.hasPreviewText) {
			expect(de['previewText']).toBe('Neu');
		} else {
			expect(de).not.toHaveProperty('previewText');
		}
	});

	it('updateTranslation on a language without an overlay is not_found', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t);

		const error = await operationError(driver.update(t, id, { language: 'fr', subject: 'x' }));
		expect(error.category).toBe('not_found');
	});

	it('removeTranslation drops the overlay and the supported language', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText));

		await driver.remove(t, id, 'de');

		const row = await read(t, id);
		expect(row?.supportedLanguages).toEqual(['en']);
		expect(overlays(row)).toEqual({});
		expect(row?.contentRevision).toBe(4);
	});

	it('setDefaultLanguage swaps the body with the overlay, and back', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText));

		await driver.setDefault(t, id, 'de');

		let row = await read(t, id);
		expect(row?.defaultLanguage).toBe('de');
		expect(row?.subject).toBe('Deutscher Betreff');
		expect(row?.contentRevision).toBe(4);
		const body = JSON.parse(row?.content ?? '[]') as Array<{
			id: string;
			content: Record<string, unknown>;
		}>;
		expect(body.map((b) => b.id)).toEqual(['b1', 'b2']);
		expect(body[0]!.content['html']).toBe('Hallo Welt');
		expect(body[1]!.content).toEqual({ text: 'Klick mich', url: 'https://x' });

		const en = overlays(row)['en']!;
		expect(overlays(row)['de']).toBeUndefined();
		expect(en['subject']).toBe('English subject');
		expect(en['blocks']).toEqual({ b1: { html: 'Hello world' }, b2: { buttonText: 'Click me' } });
		if (driver.hasPreviewText) {
			expect(row).toHaveProperty('previewText', 'Deutsche Vorschau');
			expect(en['previewText']).toBe('English preview');
		} else {
			expect(row).not.toHaveProperty('previewText');
			expect(en).not.toHaveProperty('previewText');
		}

		await driver.setDefault(t, id, 'en');

		row = await read(t, id);
		expect(row?.defaultLanguage).toBe('en');
		expect(row?.subject).toBe('English subject');
		expect(row?.content).toBe(CONTENT_EN);
		expect(overlays(row)['de']?.['subject']).toBe('Deutscher Betreff');
	});

	it('setDefaultLanguage to the current default writes nothing', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t);
		const before = await read(t, id);

		await driver.setDefault(t, id, 'en');

		expect(await read(t, id)).toEqual(before);
	});

	it('setDefaultLanguage to a language without an overlay is not_found', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t);

		const error = await operationError(driver.setDefault(t, id, 'fr'));
		expect(error.category).toBe('not_found');
	});

	it('setDefaultLanguage on a published row needs forceWhilePublished', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText, { status: 'published' }));

		const error = await operationError(driver.setDefault(t, id, 'de'));
		expect(error.category).toBe('invalid_state');
		expect(error.data?.['action']).toBe('unpublish');
		expect((await read(t, id))?.defaultLanguage).toBe('en');

		await driver.setDefault(t, id, 'de', true);
		expect((await read(t, id))?.defaultLanguage).toBe('de');
	});

	it('setDefaultLanguage refuses an editor', async () => {
		const t = convexTest(schema, modules);
		const id = await driver.seed(t, withGerman(driver.hasPreviewText));

		sessionMock.role = 'editor';
		const error = await operationError(driver.setDefault(t, id, 'de'));
		expect(error.category).toBe('forbidden');
		expect((await read(t, id))?.defaultLanguage).toBe('en');
	});
});

describe('transactional setDefaultLanguage feature gate', () => {
	it('is refused while the transactional feature is off', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({ featureFlags: { transactional: false } })
			)
		);
		const id = await drivers[1]!.seed(t, withGerman(false));

		const error = await operationError(drivers[1]!.setDefault(t, id, 'de'));
		expect(error.category).toBe('forbidden');
		expect(error.data?.['feature']).toBe('transactional');
	});
});
