/**
 * The server's render boundary for catalog copy, now that it takes a locale.
 *
 * English stays the default and that is not laziness: an API refusal, a log
 * line and a `curl` response have no reader to have a language, and they have
 * to read the same as the dialog an operator sees. What changed is that a
 * caller who DOES know who is reading — anything composed for a person whose
 * `userProfiles.locale` we hold — can now say so.
 */
import { describe, expect, it } from 'vitest';
import { localize, localizeEn } from '../localizedText';

describe('localize', () => {
	it('renders a catalog key in the requested language', () => {
		expect(localize('shared.format.never', 'en')).toBe('Never');
		expect(localize('shared.format.never', 'de')).toBe('Nie');
	});

	it('defaults to English, because most callers have no reader', () => {
		expect(localize('shared.format.never')).toBe('Never');
		expect(localizeEn('shared.format.never')).toBe('Never');
	});

	it('falls back to English for a key the translation has not caught up with', () => {
		// The same `fallbackLocale: 'en'` the browser runs with: a partially
		// translated locale renders English words, never a raw key path.
		expect(localize('shared.format.never', 'de')).not.toBe('shared.format.never');
	});

	it('passes a sentence that is already words straight through', () => {
		expect(localize('A backend refusal, verbatim.', 'de')).toBe('A backend refusal, verbatim.');
	});

	it('interpolates params', () => {
		expect(
			localize({ key: 'shell.dashboard.navigatedTo', params: { page: 'Kontakte' } }, 'de')
		).toBe('Zu Kontakte gewechselt');
	});

	it('resolves a param that is itself a key, in the same language', () => {
		// The vocabulary modules hand back keys for the values whose name is copy
		// rather than a vendor's own spelling; a sentence about one of those must
		// not read "…still send through shared.transportState.labels.x".
		const rendered = localize(
			{ key: 'shell.dashboard.navigatedTo', params: { page: 'shared.format.never' } },
			'de'
		);
		expect(rendered).toBe('Zu Nie gewechselt');
	});

	it('leaves an unfilled placeholder visible rather than printing "undefined"', () => {
		expect(localize({ key: 'shell.dashboard.navigatedTo' }, 'en')).toBe('Navigated to {page}');
	});
});
