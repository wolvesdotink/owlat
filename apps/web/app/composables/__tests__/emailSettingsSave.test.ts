import { describe, it, expect, vi } from 'vitest';
import {
	emailSettingsSave,
	type EmailSettingsBase,
	type EmailSettingsSaveArgs,
	type EmailSettingsUpdatePayload,
} from '../emailSettingsSave';
import type { RenderOptions } from '../useEmailHtmlRendering';
import { EMAIL_RENDERER_VERSION } from '@owlat/email-renderer/version';

/**
 * The template Settings save. Besides routing to `update` / `setDefaultLanguage`,
 * each write carries the delivery HTML rendered from the state it leaves and
 * the revision it was built on (issue #1077). Rendered with the real email
 * renderer, so the assertions read what a recipient would get.
 */

const renderOptions: RenderOptions = { variableType: 'personalization' };

const CONTENT = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: '<p>Hello world</p>' } },
	{ id: 'b2', type: 'button', content: { text: 'Click me', url: 'https://example.com' } },
]);

const DE = {
	subject: 'Deutscher Betreff',
	previewText: 'Vorschau',
	blocks: { b1: { html: '<p>Hallo Welt</p>' }, b2: { buttonText: 'Klick mich' } },
};

const payload = (
	overrides: Partial<EmailSettingsUpdatePayload> = {}
): EmailSettingsUpdatePayload => ({
	subject: 'English subject',
	previewText: 'English preview',
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	translations: JSON.stringify({ de: DE }),
	...overrides,
});

const base = (overrides: Partial<EmailSettingsBase> = {}): EmailSettingsBase => ({
	content: CONTENT,
	plainTextOverride: undefined,
	revision: 7,
	...overrides,
});

type Rendered = Record<string, { htmlContent: string; subject: string }>;

function save(overrides: Partial<EmailSettingsSaveArgs> = {}) {
	const update = vi.fn().mockResolvedValue({ ok: true, result: { contentRevision: 8 } });
	const setDefaultLanguage = vi.fn().mockResolvedValue({ ok: true, result: 'tmpl_1' });
	const args: EmailSettingsSaveArgs = {
		persistedDefaultLanguage: 'en',
		selectedDefaultLanguage: 'en',
		overlayLanguages: ['de'],
		updatePayload: payload(),
		base: base(),
		renderOptions,
		update,
		setDefaultLanguage,
		...overrides,
	};
	return { args, update, setDefaultLanguage, run: () => emailSettingsSave(args) };
}

/** The `htmlTranslations` blob of a recorded write. */
const htmlTranslationsOf = (call: unknown): Rendered =>
	JSON.parse((call as { htmlTranslations: string }).htmlTranslations) as Rendered;

describe('emailSettingsSave', () => {
	it('routes a plain edit (unchanged default language) through update', async () => {
		const { update, setDefaultLanguage, run } = save();

		const result = await run();

		expect(result).toEqual({ status: 'saved' });
		expect(update).toHaveBeenCalledWith(expect.objectContaining(payload()));
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('persists pending edits BEFORE swapping on a default-language change', async () => {
		const order: string[] = [];
		const update = vi.fn().mockImplementation(() => {
			order.push('update');
			return Promise.resolve({ ok: true, result: { contentRevision: 8 } });
		});
		const setDefaultLanguage = vi.fn().mockImplementation(() => {
			order.push('setDefaultLanguage');
			return Promise.resolve({ ok: true, result: 'tmpl_1' });
		});
		const { run } = save({
			selectedDefaultLanguage: 'de',
			updatePayload: payload({ defaultLanguage: 'de' }),
			update,
			setDefaultLanguage,
		});

		const result = await run();

		expect(result).toEqual({ status: 'language-promoted' });
		// Step 1: persist field edits / overlays, but hold defaultLanguage at the
		// persisted value so the swap reads the correct outgoing content.
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining(payload({ defaultLanguage: 'en' }))
		);
		// Step 2: promote the now-persisted overlay.
		expect(setDefaultLanguage).toHaveBeenCalledWith(expect.objectContaining({ language: 'de' }));
		expect(order).toEqual(['update', 'setDefaultLanguage']);
		// Both writes store HTML, so both name the renderer that produced it.
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ rendererVersion: EMAIL_RENDERER_VERSION })
		);
		expect(setDefaultLanguage).toHaveBeenCalledWith(
			expect.objectContaining({ rendererVersion: EMAIL_RENDERER_VERSION })
		);
	});

	it('persists a freshly-typed subject in the same save as a default-language swap', async () => {
		// User picks 'de' as the new default AND types a German subject in the card
		// above the dropdown. The typed subject must not be silently dropped.
		const combinedPayload = payload({
			defaultLanguage: 'de',
			subject: 'Frisch getippter Betreff',
			translations: JSON.stringify({ de: { ...DE, subject: 'Frisch getippter Betreff' } }),
		});
		const { update, setDefaultLanguage, run } = save({
			selectedDefaultLanguage: 'de',
			updatePayload: combinedPayload,
		});

		const result = await run();

		expect(result).toEqual({ status: 'language-promoted' });
		// The combined edit IS persisted (defaultLanguage held at 'en' so the swap
		// can re-key from correct outgoing content).
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ ...combinedPayload, defaultLanguage: 'en' })
		);
		expect(setDefaultLanguage).toHaveBeenCalledWith(expect.objectContaining({ language: 'de' }));
	});

	it('persists a just-added overlay before promoting it (no backend not-found)', async () => {
		// User adds 'fr' via addLanguage() and promotes it to default in the same
		// save. The overlay is persisted first so setDefaultLanguage finds it.
		const withFr = payload({
			defaultLanguage: 'fr',
			supportedLanguages: ['en', 'de', 'fr'],
			translations: JSON.stringify({
				de: DE,
				fr: { subject: 'Sujet', previewText: 'Aperçu' },
			}),
		});
		const { update, setDefaultLanguage, run } = save({
			// 'fr' is in overlayLanguages because the form carries its overlay; the
			// swap is preceded by a persisting update, so it is a valid target.
			selectedDefaultLanguage: 'fr',
			overlayLanguages: ['de', 'fr'],
			updatePayload: withFr,
		});

		const result = await run();

		expect(result).toEqual({ status: 'language-promoted' });
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ ...withFr, defaultLanguage: 'en' })
		);
		expect(setDefaultLanguage).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr' }));
	});

	it('aborts the swap (and reports failed) when the pre-swap update fails', async () => {
		const { setDefaultLanguage, run } = save({
			selectedDefaultLanguage: 'de',
			updatePayload: payload({ defaultLanguage: 'de' }),
			update: vi.fn().mockResolvedValue({ ok: false }),
		});

		const result = await run();

		expect(result).toEqual({ status: 'failed' });
		// The swap must not run if the persisting update failed — otherwise the
		// swap would read stale state and the pending edits would be lost.
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('refuses to promote a default language that has no overlay', async () => {
		const { update, setDefaultLanguage, run } = save({
			selectedDefaultLanguage: 'fr',
			updatePayload: payload({ defaultLanguage: 'fr' }),
		});

		const result = await run();

		expect(result).toEqual({ status: 'no-overlay', language: 'fr' });
		expect(update).not.toHaveBeenCalled();
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('reports failed when update fails (its own error already toasted)', async () => {
		const { run } = save({ update: vi.fn().mockResolvedValue({ ok: false }) });

		expect(await run()).toEqual({ status: 'failed' });
	});

	it('reports failed when setDefaultLanguage fails', async () => {
		// Step 1 (persist) succeeds, step 2 (swap) fails.
		const { run } = save({
			selectedDefaultLanguage: 'de',
			updatePayload: payload({ defaultLanguage: 'de' }),
			setDefaultLanguage: vi.fn().mockResolvedValue({ ok: false }),
		});

		expect(await run()).toEqual({ status: 'failed' });
	});

	describe('delivery HTML in the same write', () => {
		it('renders every remaining language from its overlay, with the edited subject', async () => {
			const { update, run } = save({
				updatePayload: payload({
					translations: JSON.stringify({ de: { ...DE, subject: ' Neuer Betreff ' } }),
				}),
			});

			await run();

			const write = update.mock.calls[0]![0];
			expect(write.expectedContentRevision).toBe(7);
			const rendered = htmlTranslationsOf(write);
			expect(Object.keys(rendered)).toEqual(['de']);
			expect(rendered['de']!.subject).toBe('Neuer Betreff');
			expect(rendered['de']!.htmlContent).toContain('Hallo Welt');
			expect(rendered['de']!.htmlContent).toContain('Klick mich');
			expect(rendered['de']!.htmlContent).toContain('https://example.com');
			expect(rendered['de']!.htmlContent).not.toContain('Hello world');
		});

		it('drops a removed language and renders an added one', async () => {
			// German removed, Spanish added with only a subject typed: its body is
			// the default content until someone translates it.
			const { update, run } = save({
				updatePayload: payload({
					supportedLanguages: ['en', 'es'],
					translations: JSON.stringify({ es: { subject: 'Asunto', previewText: '' } }),
				}),
			});

			await run();

			const rendered = htmlTranslationsOf(update.mock.calls[0]![0]);
			expect(Object.keys(rendered)).toEqual(['es']);
			expect(rendered['es']!.subject).toBe('Asunto');
			expect(rendered['es']!.htmlContent).toContain('Hello world');
		});

		it('sends the default subject for a language whose subject was left empty', async () => {
			const { update, run } = save({
				updatePayload: payload({
					subject: ' English subject ',
					supportedLanguages: ['en', 'de', 'fr'],
					translations: JSON.stringify({ de: DE, fr: { subject: '  ', previewText: '' } }),
				}),
			});

			await run();

			expect(htmlTranslationsOf(update.mock.calls[0]![0])['fr']!.subject).toBe('English subject');
		});

		it('renders the swap from the row step 1 leaves, on the revision it stored', async () => {
			const { update, setDefaultLanguage, run } = save({
				selectedDefaultLanguage: 'de',
				updatePayload: payload({
					defaultLanguage: 'de',
					supportedLanguages: ['en', 'de', 'fr'],
					translations: JSON.stringify({
						de: DE,
						// French translates only the button, so after the swap its body
						// text is the new default's (German) text.
						fr: { subject: 'Sujet', blocks: { b2: { buttonText: 'Cliquez' } } },
					}),
				}),
			});

			await run();

			// Step 1 is a consistent state of its own: German still an overlay.
			const step1 = htmlTranslationsOf(update.mock.calls[0]![0]);
			expect(Object.keys(step1).sort()).toEqual(['de', 'fr']);
			expect(step1['de']!.htmlContent).toContain('Hallo Welt');

			const swap = setDefaultLanguage.mock.calls[0]![0];
			// Named by the revision step 1 reported, not the base's.
			expect(swap.expectedContentRevision).toBe(8);
			// The new default's body and text part are German.
			expect(swap.htmlContent).toContain('Hallo Welt');
			expect(swap.htmlContent).toContain('Klick mich');
			expect(swap.htmlContent).not.toContain('Hello world');
			expect(swap.plainTextContent).toContain('Hallo Welt');
			expect(swap.plainTextContent).not.toContain('Hello world');
			// It is the same document step 1 rendered for German.
			expect(swap.htmlContent).toBe(step1['de']!.htmlContent);

			const rendered = htmlTranslationsOf(swap);
			expect(Object.keys(rendered).sort()).toEqual(['en', 'fr']);
			// The outgoing default is an overlay with its own body and subject.
			expect(rendered['en']).toEqual({
				htmlContent: expect.stringContaining('Hello world'),
				subject: 'English subject',
			});
			expect(rendered['en']!.htmlContent).toContain('Click me');
			expect(rendered['en']!.htmlContent).not.toContain('Hallo Welt');
			// French is rendered on the swapped body.
			expect(rendered['fr']!.subject).toBe('Sujet');
			expect(rendered['fr']!.htmlContent).toContain('Cliquez');
			expect(rendered['fr']!.htmlContent).toContain('Hallo Welt');
		});

		it('keeps the outgoing default deliverable when its pill was removed', async () => {
			const { setDefaultLanguage, run } = save({
				selectedDefaultLanguage: 'de',
				updatePayload: payload({ defaultLanguage: 'de', supportedLanguages: ['de'] }),
			});

			await run();

			expect(Object.keys(htmlTranslationsOf(setDefaultLanguage.mock.calls[0]![0]))).toEqual(['en']);
		});

		it("keeps the author's own text body across a swap", async () => {
			const { setDefaultLanguage, run } = save({
				selectedDefaultLanguage: 'de',
				updatePayload: payload({ defaultLanguage: 'de' }),
				base: base({ plainTextOverride: 'Handgeschrieben' }),
			});

			await run();

			expect(setDefaultLanguage.mock.calls[0]![0].plainTextContent).toBe('Handgeschrieben');
		});

		it('writes nothing when the HTML cannot be rendered', async () => {
			const plain = save({ updatePayload: payload({ translations: 'not json' }) });
			expect(await plain.run()).toMatchObject({ status: 'render-failed' });
			expect(plain.update).not.toHaveBeenCalled();

			// The swap is rendered before step 1 is written, so a swap that cannot
			// be rendered leaves the row untouched too.
			const swap = save({
				selectedDefaultLanguage: 'de',
				updatePayload: payload({ defaultLanguage: 'de' }),
				base: base({ content: 'not json' }),
			});
			expect(await swap.run()).toMatchObject({ status: 'render-failed' });
			expect(swap.update).not.toHaveBeenCalled();
			expect(swap.setDefaultLanguage).not.toHaveBeenCalled();
		});
	});
});
