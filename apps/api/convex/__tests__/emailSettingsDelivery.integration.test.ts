/**
 * The template Settings page's writes and what a campaign delivers right after
 * them (issue #1077). The page changes language data through
 * `emailTemplates.emails.update` and `emailTemplates.i18n.setDefaultLanguage`;
 * both must leave the stored delivery HTML, subject and text/plain body in the
 * same language as the row, in the same write, because the send path
 * (`getEmailTemplateForLanguage`) delivers the stored HTML directly. The HTML
 * strings stand in for what the page renders; the web app's
 * `emailSettingsSave` tests cover the rendering itself.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import { createTestEmailTemplate } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = { userId: 'user-settings', role: 'owner' as const };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		getMutationContext: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-settings'),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
	};
});

const modules = import.meta.glob('../**/*.*s');

type T = TestConvex<typeof schema>;

const CONTENT_EN = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: 'Hello world' } },
	{ id: 'b2', type: 'button', content: { text: 'Click me', url: 'https://example.com' } },
]);

/** A template as the editor last saved it: English default, German overlay. */
function seed(t: T, overrides: Record<string, unknown> = {}) {
	return t.run((ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				subject: 'English subject',
				previewText: 'English preview',
				content: CONTENT_EN,
				htmlContent: '<p>Hello world</p>',
				plainTextContent: 'Hello world',
				defaultLanguage: 'en',
				supportedLanguages: ['en', 'de'],
				translations: JSON.stringify({
					de: {
						subject: 'Deutscher Betreff',
						previewText: 'Deutsche Vorschau',
						blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick mich' } },
					},
				}),
				htmlTranslations: JSON.stringify({
					de: { htmlContent: '<p>Hallo Welt</p>', subject: 'Deutscher Betreff' },
				}),
				contentRevision: 5,
				...overrides,
			})
		)
	);
}

const read = (t: T, id: Id<'emailTemplates'>) => t.run((ctx) => ctx.db.get(id));

const deliver = (t: T, templateId: Id<'emailTemplates'>, language: string) =>
	t.query(internal.campaigns.sendQueries.getEmailTemplateForLanguage, { templateId, language });

const rendered = (row: { htmlTranslations?: string } | null) =>
	JSON.parse(row?.htmlTranslations ?? '{}') as Record<
		string,
		{ htmlContent: string; subject: string }
	>;

/** Resolve a rejected mutation to its Operation error payload. */
async function operationError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<{ category: string; data?: Record<string, Value> }>).data;
}

describe('Settings page: default-language change', () => {
	// What the page sends after swapping: the German body rendered as the new
	// default, and English rendered as an overlay.
	const swapped = {
		htmlContent: '<p>Hallo Welt</p>',
		plainTextContent: 'Hallo Welt',
		htmlTranslations: JSON.stringify({
			en: { htmlContent: '<p>Hello world</p>', subject: 'English subject' },
		}),
	};

	it('stores the new default delivery HTML, text body and subject in the swap', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);

		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId: id,
			language: 'de',
			...swapped,
			expectedContentRevision: 5,
		});

		const row = await read(t, id);
		expect(row?.defaultLanguage).toBe('de');
		expect(row?.contentRevision).toBe(6);
		expect(row?.subject).toBe('Deutscher Betreff');
		expect(row?.htmlContent).toBe('<p>Hallo Welt</p>');
		expect(row?.plainTextContent).toBe('Hallo Welt');
		expect(rendered(row)).toEqual({
			en: { htmlContent: '<p>Hello world</p>', subject: 'English subject' },
		});
	});

	it('a send right after the swap delivers one language per recipient', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);

		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId: id,
			language: 'de',
			...swapped,
			expectedContentRevision: 5,
		});

		// German is the default now.
		expect(await deliver(t, id, 'de')).toEqual({
			htmlContent: '<p>Hallo Welt</p>',
			subject: 'Deutscher Betreff',
			plainTextContent: 'Hallo Welt',
			resolvedLanguage: 'de',
		});
		// English is an overlay now, with its own subject.
		expect(await deliver(t, id, 'en')).toEqual({
			htmlContent: '<p>Hello world</p>',
			subject: 'English subject',
			resolvedLanguage: 'en',
		});
	});

	it('keeps the outgoing default supported, so its recipients still get it', async () => {
		const t = convexTest(schema, modules);
		// The Settings page lets the default's own pill be removed.
		const id = await seed(t, { supportedLanguages: ['de'] });

		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId: id,
			language: 'de',
			...swapped,
			expectedContentRevision: 5,
		});

		const row = await read(t, id);
		expect(row?.supportedLanguages).toEqual(['de', 'en']);
		expect((await deliver(t, id, 'en'))?.subject).toBe('English subject');
	});

	it('clears a pending saved-block rerender, whose HTML the swap replaced', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { htmlRenderState: { stale: true, failureCount: 0 } });

		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId: id,
			language: 'de',
			...swapped,
			expectedContentRevision: 5,
		});

		expect((await read(t, id))?.htmlRenderState).toEqual({ stale: false });
	});

	it('a swap built on an older revision is refused and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		const before = await read(t, id);

		const error = await operationError(
			t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
				templateId: id,
				language: 'de',
				...swapped,
				expectedContentRevision: 4,
			})
		);

		expect(error.category).toBe('conflict');
		expect(error.data?.['reason']).toBe('stale_content_revision');
		expect(await read(t, id)).toEqual(before);
	});
});

describe('Settings page: editing, adding and removing languages', () => {
	it('stores the edited subject, an added language and a removal with the overlays', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, {
			supportedLanguages: ['en', 'de', 'fr'],
			translations: JSON.stringify({
				de: { subject: 'Deutscher Betreff', blocks: { b1: { html: 'Hallo Welt' } } },
				fr: { subject: 'Sujet', blocks: { b1: { html: 'Bonjour' } } },
			}),
			htmlTranslations: JSON.stringify({
				de: { htmlContent: '<p>Hallo Welt</p>', subject: 'Deutscher Betreff' },
				fr: { htmlContent: '<p>Bonjour</p>', subject: 'Sujet' },
			}),
		});

		// German subject edited, French removed, Spanish added: one write, as
		// the page sends it.
		const result = await t.mutation(api.emailTemplates.emails.update, {
			templateId: id,
			subject: 'English subject',
			previewText: 'English preview',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de', 'es'],
			translations: JSON.stringify({
				de: { subject: 'Neuer Betreff', blocks: { b1: { html: 'Hallo Welt' } } },
				es: { subject: 'Asunto', previewText: '' },
			}),
			htmlTranslations: JSON.stringify({
				de: { htmlContent: '<p>Hallo Welt</p>', subject: 'Neuer Betreff' },
				es: { htmlContent: '<p>Hello world</p>', subject: 'Asunto' },
			}),
			expectedContentRevision: 5,
		});

		expect(result.contentRevision).toBe(6);
		const row = await read(t, id);
		expect(rendered(row)).toEqual({
			de: { htmlContent: '<p>Hallo Welt</p>', subject: 'Neuer Betreff' },
			es: { htmlContent: '<p>Hello world</p>', subject: 'Asunto' },
		});

		expect(await deliver(t, id, 'de')).toEqual({
			htmlContent: '<p>Hallo Welt</p>',
			subject: 'Neuer Betreff',
			resolvedLanguage: 'de',
		});
		expect((await deliver(t, id, 'es'))?.subject).toBe('Asunto');
		// French recipients fall back to the default language.
		expect(await deliver(t, id, 'fr')).toEqual({
			htmlContent: '<p>Hello world</p>',
			subject: 'English subject',
			plainTextContent: 'Hello world',
			resolvedLanguage: 'en',
		});
	});

	it('a Settings save built on an older revision is refused and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		const before = await read(t, id);

		const error = await operationError(
			t.mutation(api.emailTemplates.emails.update, {
				templateId: id,
				supportedLanguages: ['en'],
				translations: '{}',
				htmlTranslations: '{}',
				expectedContentRevision: 3,
			})
		);

		expect(error.category).toBe('conflict');
		expect(await read(t, id)).toEqual(before);
	});
});

describe('send path: languages the template no longer supports', () => {
	it('does not deliver HTML still stored for a removed language', async () => {
		const t = convexTest(schema, modules);
		// Removed by an older client: the overlay is gone, its HTML is not.
		const id = await seed(t, { supportedLanguages: ['en'], translations: '{}' });

		expect(await deliver(t, id, 'de')).toEqual({
			htmlContent: '<p>Hello world</p>',
			subject: 'English subject',
			plainTextContent: 'Hello world',
			resolvedLanguage: 'en',
		});
	});

	it('a row without a supported-language list keeps delivering its stored HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { supportedLanguages: undefined });

		expect((await deliver(t, id, 'de'))?.resolvedLanguage).toBe('de');
	});
});
