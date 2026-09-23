/**
 * One word for a live automation (#786). The Marketing sidebar marks each
 * listed automation with the shared "running" status pill, while the list,
 * detail and filter tabs call the same state "Active". The pill now reads the
 * same word in every language the app ships.
 */
import { describe, it, expect } from 'vitest';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { CONVERSATION_STATUS_LABEL } from '~/utils/conversationStatus';

type Catalog = Record<string, unknown>;
const at = (catalog: Catalog, path: string): unknown =>
	path.split('.').reduce<unknown>((node, key) => (node as Catalog)[key], catalog);

describe.each([
	['en', en, 'Active'],
	['de', de, 'Aktiv'],
])('%s', (_lang, catalog, word) => {
	it('uses the list word for a live automation in the sidebar', () => {
		expect(at(catalog as Catalog, 'shared.useAutomationBadges.status.active')).toBe(word);
		expect(at(catalog as Catalog, 'common.active')).toBe(word);
		expect(at(catalog as Catalog, CONVERSATION_STATUS_LABEL.running)).toBe(word);
	});
});
