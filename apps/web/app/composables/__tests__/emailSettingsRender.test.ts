import { describe, it, expect } from 'vitest';
import { itemTextKey, mergeTranslationIntoItem } from '@owlat/api/translationMerge';
import { promoteLanguage } from '../emailSettingsRender';

/**
 * Making a language the default on the Settings page stores the same state as
 * the backend swap: list items, table text and menu labels are keyed by their
 * source text, so every overlay has to move to the new default's text.
 */
describe('promoteLanguage', () => {
	const list = (items: string[]) => [
		{ id: 'l1', type: 'list', content: { items, listType: 'bullet' } },
	];
	const k = itemTextKey;

	it('keeps every language translating the list after the default changes', () => {
		const state = promoteLanguage(
			{
				content: JSON.stringify(list(['Free shipping', 'Returns'])),
				subject: 'Order',
				defaultLanguage: 'en',
				supportedLanguages: ['en', 'de', 'fr'],
				translations: {
					de: {
						subject: 'Bestellung',
						blocks: {
							l1: {
								texts: { [k('Free shipping')]: 'Versandkostenfrei', [k('Returns')]: 'Rückgabe' },
							},
						},
					},
					fr: { subject: 'Commande', blocks: { l1: { texts: { [k('Returns')]: 'Retours' } } } },
				},
			},
			'de'
		);
		const items = (language: string) => {
			const blocks = JSON.parse(state.content) as ReturnType<typeof list>;
			const overlay = state.translations[language]?.blocks ?? {};
			return mergeTranslationIntoItem(blocks[0]!, overlay).content['items'];
		};
		expect(JSON.parse(state.content)[0].content.items).toEqual(['Versandkostenfrei', 'Rückgabe']);
		expect(items('en')).toEqual(['Free shipping', 'Returns']);
		expect(items('fr')).toEqual(['Versandkostenfrei', 'Retours']);
	});
});
