/**
 * Translation mutations for both publishable-email tables, `emailTemplates`
 * (`emailTemplates/i18n.ts`) and `transactionalEmails`
 * (`transactional/translations.ts`). Both are shells around the `*Patch`
 * helpers in `lib/emailTranslations.ts`; the same scenarios run against each
 * table through a small driver so a translation fix cannot reach only one side
 * (issue #862 finding 6). Transactional emails carry no previewText, so their
 * cases assert it is never written. Only templates expose `setDefaultLanguage`,
 * so the swap cases run for the drivers that carry one.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

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
	htmlContent?: string;
	expectedContentRevision?: number;
}

/** What the add / remove mutations accept beyond the row and the language. */
interface WriteOptions {
	htmlContent?: string;
	expectedContentRevision?: number;
}

interface Driver {
	table: Table;
	hasPreviewText: boolean;
	seed: (t: T, overrides?: Record<string, unknown>) => Promise<RowId>;
	add: (t: T, id: RowId, language: string, options?: WriteOptions) => Promise<unknown>;
	update: (t: T, id: RowId, args: UpdateArgs) => Promise<unknown>;
	remove: (
		t: T,
		id: RowId,
		language: string,
		options?: Pick<WriteOptions, 'expectedContentRevision'>
	) => Promise<unknown>;
	setDefault?: (t: T, id: RowId, language: string, force?: boolean) => Promise<unknown>;
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
		add: (t, id, language, options) =>
			t.mutation(api.emailTemplates.i18n.addTranslation, {
				templateId: asTemplate(id),
				language,
				...options,
			}),
		update: (t, id, args) =>
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId: asTemplate(id),
				...args,
			}),
		remove: (t, id, language, options) =>
			t.mutation(api.emailTemplates.i18n.removeTranslation, {
				templateId: asTemplate(id),
				language,
				...options,
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
		add: (t, id, language, options) =>
			t.mutation(api.transactional.translations.addTranslation, {
				id: asTransactional(id),
				language,
				...options,
			}),
		// The transactional mutation takes no previewText argument.
		update: (t, id, { previewText: _previewText, ...args }) =>
			t.mutation(api.transactional.translations.updateTranslation, {
				id: asTransactional(id),
				...args,
			}),
		remove: (t, id, language, options) =>
			t.mutation(api.transactional.translations.removeTranslation, {
				id: asTransactional(id),
				language,
				...options,
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
	const setDefault = driver.setDefault;

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

	// The delivery HTML is rendered on the server from the stored overlays
	// (lib/publishableEmail.ts); HTML a client sends is ignored.
	describe('overlay and delivery HTML as one revision', () => {
		const rendered = (row: { htmlTranslations?: string } | null) =>
			JSON.parse(row?.htmlTranslations ?? '{}') as Record<
				string,
				{ htmlContent: string; subject: string }
			>;
		const withRendered = (extra: Record<string, unknown> = {}) =>
			withGerman(driver.hasPreviewText, {
				supportedLanguages: ['en', 'de', 'fr'],
				translations: JSON.stringify({
					de: {
						subject: 'Deutscher Betreff',
						...(driver.hasPreviewText ? { previewText: 'Deutsche Vorschau' } : {}),
						blocks: DE_BLOCKS,
					},
					fr: { subject: 'Sujet', blocks: { b1: { html: 'Bonjour' } } },
				}),
				htmlTranslations: JSON.stringify({
					de: { htmlContent: '<p>Stale</p>', subject: 'Deutscher Betreff' },
					fr: { htmlContent: '<p>Stale</p>', subject: 'Sujet' },
				}),
				...extra,
			});

		it('updateTranslation writes the overlay and its HTML in the same write', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t, withRendered());

			const result = await driver.update(t, id, {
				language: 'de',
				subject: ' Neuer Betreff ',
				blocks: JSON.stringify({ b1: { html: 'Neu' } }),
				htmlContent: '<p>Client HTML</p>',
				expectedContentRevision: 3,
			});

			const row = await read(t, id);
			expect(result).toMatchObject({ contentRevision: 4 });
			expect(row?.contentRevision).toBe(4);
			expect(overlays(row)['de']?.['blocks']).toEqual({ b1: { html: 'Neu' } });
			// The HTML is rendered from the stored overlay with the subject it
			// stored (trimmed); every other language is rendered from its own.
			const html = rendered(row);
			expect(Object.keys(html).sort()).toEqual(['de', 'fr']);
			expect(html['de']?.subject).toBe('Neuer Betreff');
			expect(html['de']?.htmlContent).toContain('Neu');
			expect(html['de']?.htmlContent).not.toContain('Client HTML');
			expect(html['fr']).toMatchObject({ subject: 'Sujet' });
			expect(html['fr']?.htmlContent).toContain('Bonjour');
		});

		it('updateTranslation built on an older revision is refused and writes nothing', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t, withRendered());
			const before = await read(t, id);

			const error = await operationError(
				driver.update(t, id, {
					language: 'de',
					subject: 'Veraltet',
					htmlContent: '<p>Veraltet</p>',
					expectedContentRevision: 2,
				})
			);

			expect(error.category).toBe('conflict');
			expect(error.data?.['reason']).toBe('stale_content_revision');
			expect(await read(t, id)).toEqual(before);
		});

		it('addTranslation stores the new language with its HTML', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t);

			const result = await driver.add(t, id, 'de', {
				htmlContent: '<p>Client HTML</p>',
				expectedContentRevision: 3,
			});

			const row = await read(t, id);
			expect(result).toMatchObject({ contentRevision: 4 });
			expect(row?.supportedLanguages).toEqual(['en', 'de']);
			// The seeded overlay is the default text, rendered with the default subject.
			const html = rendered(row);
			expect(Object.keys(html)).toEqual(['de']);
			expect(html['de']?.subject).toBe('English subject');
			expect(html['de']?.htmlContent).toContain('Hello world');
			expect(html['de']?.htmlContent).not.toContain('Client HTML');
		});

		it('addTranslation built on an older revision is refused', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t);
			const before = await read(t, id);

			const error = await operationError(
				driver.add(t, id, 'de', { htmlContent: '<p>x</p>', expectedContentRevision: 1 })
			);

			expect(error.category).toBe('conflict');
			expect(await read(t, id)).toEqual(before);
		});

		it('removeTranslation drops the language HTML with the overlay', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t, withRendered());

			await driver.remove(t, id, 'de', { expectedContentRevision: 3 });

			const row = await read(t, id);
			expect(row?.supportedLanguages).toEqual(['en', 'fr']);
			expect(overlays(row)['de']).toBeUndefined();
			const html = rendered(row);
			expect(Object.keys(html)).toEqual(['fr']);
			expect(html['fr']?.htmlContent).toContain('Bonjour');
		});

		it('removeTranslation built on an older revision is refused', async () => {
			const t = convexTest(schema, modules);
			const id = await driver.seed(t, withRendered());
			const before = await read(t, id);

			const error = await operationError(
				driver.remove(t, id, 'de', { expectedContentRevision: 0 })
			);

			expect(error.category).toBe('conflict');
			expect(await read(t, id)).toEqual(before);
		});
	});

	if (setDefault) {
		describe('setDefaultLanguage', () => {
			it('setDefaultLanguage swaps the body with the overlay, and back', async () => {
				const t = convexTest(schema, modules);
				const id = await driver.seed(t, withGerman(driver.hasPreviewText));

				await setDefault(t, id, 'de');

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
				expect(en['blocks']).toEqual({
					b1: { html: 'Hello world' },
					b2: { buttonText: 'Click me' },
				});
				if (driver.hasPreviewText) {
					expect(row).toHaveProperty('previewText', 'Deutsche Vorschau');
					expect(en['previewText']).toBe('English preview');
				} else {
					expect(row).not.toHaveProperty('previewText');
					expect(en).not.toHaveProperty('previewText');
				}

				await setDefault(t, id, 'en');

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

				await setDefault(t, id, 'en');

				expect(await read(t, id)).toEqual(before);
			});

			it('setDefaultLanguage to a language without an overlay is not_found', async () => {
				const t = convexTest(schema, modules);
				const id = await driver.seed(t);

				const error = await operationError(setDefault(t, id, 'fr'));
				expect(error.category).toBe('not_found');
			});

			it('setDefaultLanguage on a published row needs forceWhilePublished', async () => {
				const t = convexTest(schema, modules);
				const id = await driver.seed(t, withGerman(driver.hasPreviewText, { status: 'published' }));

				const error = await operationError(setDefault(t, id, 'de'));
				expect(error.category).toBe('invalid_state');
				expect(error.data?.['action']).toBe('unpublish');
				expect((await read(t, id))?.defaultLanguage).toBe('en');

				await setDefault(t, id, 'de', true);
				expect((await read(t, id))?.defaultLanguage).toBe('de');
			});

			it('setDefaultLanguage refuses an editor', async () => {
				const t = convexTest(schema, modules);
				const id = await driver.seed(t, withGerman(driver.hasPreviewText));

				sessionMock.role = 'editor';
				const error = await operationError(setDefault(t, id, 'de'));
				expect(error.category).toBe('forbidden');
				expect((await read(t, id))?.defaultLanguage).toBe('en');
			});
		});
	}
});
