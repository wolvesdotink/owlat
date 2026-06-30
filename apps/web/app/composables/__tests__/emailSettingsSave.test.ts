import { describe, it, expect, vi } from 'vitest';
import {
	emailSettingsSave,
	type EmailSettingsUpdatePayload,
} from '../emailSettingsSave';

const payload = (
	overrides: Partial<EmailSettingsUpdatePayload> = {},
): EmailSettingsUpdatePayload => ({
	subject: 'English subject',
	previewText: 'English preview',
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	translations: JSON.stringify({ de: { subject: 'Betreff', previewText: 'Vorschau' } }),
	...overrides,
});

describe('emailSettingsSave', () => {
	it('routes a plain edit (unchanged default language) through update', async () => {
		const update = vi.fn().mockResolvedValue('tmpl_1');
		const setDefaultLanguage = vi.fn();
		const updatePayload = payload();

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'en',
			overlayLanguages: ['de'],
			updatePayload,
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'saved' });
		expect(update).toHaveBeenCalledWith(updatePayload);
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('persists pending edits BEFORE swapping on a default-language change', async () => {
		const update = vi.fn().mockResolvedValue('tmpl_1');
		const setDefaultLanguage = vi.fn().mockResolvedValue('tmpl_1');
		const order: string[] = [];
		update.mockImplementation(() => {
			order.push('update');
			return Promise.resolve('tmpl_1');
		});
		setDefaultLanguage.mockImplementation(() => {
			order.push('setDefaultLanguage');
			return Promise.resolve('tmpl_1');
		});

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'de',
			overlayLanguages: ['de'],
			updatePayload: payload({ defaultLanguage: 'de' }),
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'language-promoted' });
		// Step 1: persist field edits / overlays, but hold defaultLanguage at the
		// persisted value so the swap reads the correct outgoing content.
		expect(update).toHaveBeenCalledWith(payload({ defaultLanguage: 'en' }));
		// Step 2: promote the now-persisted overlay.
		expect(setDefaultLanguage).toHaveBeenCalledWith({ language: 'de' });
		expect(order).toEqual(['update', 'setDefaultLanguage']);
	});

	it('persists a freshly-typed subject in the same save as a default-language swap', async () => {
		// User picks 'de' as the new default AND types a German subject in the card
		// above the dropdown. The typed subject must not be silently dropped.
		const update = vi.fn().mockResolvedValue('tmpl_1');
		const setDefaultLanguage = vi.fn().mockResolvedValue('tmpl_1');
		const combinedPayload = payload({
			defaultLanguage: 'de',
			subject: 'Frisch getippter Betreff',
			translations: JSON.stringify({
				de: { subject: 'Frisch getippter Betreff', previewText: 'Vorschau' },
			}),
		});

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'de',
			overlayLanguages: ['de'],
			updatePayload: combinedPayload,
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'language-promoted' });
		// The combined edit IS persisted (defaultLanguage held at 'en' so the swap
		// can re-key from correct outgoing content).
		expect(update).toHaveBeenCalledWith({ ...combinedPayload, defaultLanguage: 'en' });
		expect(setDefaultLanguage).toHaveBeenCalledWith({ language: 'de' });
	});

	it('persists a just-added overlay before promoting it (no backend not-found)', async () => {
		// User adds 'fr' via addLanguage() and promotes it to default in the same
		// save. The overlay is persisted first so setDefaultLanguage finds it.
		const update = vi.fn().mockResolvedValue('tmpl_1');
		const setDefaultLanguage = vi.fn().mockResolvedValue('tmpl_1');
		const withFr = payload({
			defaultLanguage: 'fr',
			supportedLanguages: ['en', 'de', 'fr'],
			translations: JSON.stringify({
				de: { subject: 'Betreff', previewText: 'Vorschau' },
				fr: { subject: 'Sujet', previewText: 'Aperçu' },
			}),
		});

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			// 'fr' is in overlayLanguages because the form carries its overlay; the
			// swap is preceded by a persisting update, so it is a valid target.
			selectedDefaultLanguage: 'fr',
			overlayLanguages: ['de', 'fr'],
			updatePayload: withFr,
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'language-promoted' });
		expect(update).toHaveBeenCalledWith({ ...withFr, defaultLanguage: 'en' });
		expect(setDefaultLanguage).toHaveBeenCalledWith({ language: 'fr' });
	});

	it('aborts the swap (and reports failed) when the pre-swap update fails', async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const setDefaultLanguage = vi.fn();

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'de',
			overlayLanguages: ['de'],
			updatePayload: payload({ defaultLanguage: 'de' }),
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'failed' });
		// The swap must not run if the persisting update failed — otherwise the
		// swap would read stale state and the pending edits would be lost.
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('refuses to promote a default language that has no overlay', async () => {
		const update = vi.fn();
		const setDefaultLanguage = vi.fn();

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'fr',
			overlayLanguages: ['de'],
			updatePayload: payload({ defaultLanguage: 'fr' }),
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'no-overlay', language: 'fr' });
		expect(update).not.toHaveBeenCalled();
		expect(setDefaultLanguage).not.toHaveBeenCalled();
	});

	it('reports failed when update resolves undefined (its own error already toasted)', async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		const setDefaultLanguage = vi.fn();

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'en',
			overlayLanguages: ['de'],
			updatePayload: payload(),
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'failed' });
	});

	it('reports failed when setDefaultLanguage resolves undefined', async () => {
		// Step 1 (persist) succeeds, step 2 (swap) fails.
		const update = vi.fn().mockResolvedValue('tmpl_1');
		const setDefaultLanguage = vi.fn().mockResolvedValue(undefined);

		const result = await emailSettingsSave({
			persistedDefaultLanguage: 'en',
			selectedDefaultLanguage: 'de',
			overlayLanguages: ['de'],
			updatePayload: payload({ defaultLanguage: 'de' }),
			update,
			setDefaultLanguage,
		});

		expect(result).toEqual({ status: 'failed' });
	});
});
