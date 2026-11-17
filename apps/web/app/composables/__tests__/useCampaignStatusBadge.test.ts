/**
 * The campaign list's status badge ("Draft", "Sent", …) is read in the reader's
 * language: its label is a catalog key that both locales carry, never an
 * English string that every locale shows as is.
 */
import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { useCampaignStatusBadge, type CampaignStatus } from '../useCampaignStatusBadge';

const STATUSES: CampaignStatus[] = [
	'draft',
	'scheduled',
	'sending',
	'sent',
	'cancelled',
	'pending_review',
];

function translator(locale: 'en' | 'de') {
	return createI18n({ legacy: false, locale, messages: { en, de } }).global;
}

describe('campaign status badge labels', () => {
	it('are catalog keys both locales translate', () => {
		const { getStatusBadge } = useCampaignStatusBadge();
		const english = translator('en');
		const german = translator('de');
		for (const status of STATUSES) {
			const { label } = getStatusBadge(status);
			expect(english.te(label, 'en'), `${status} in en`).toBe(true);
			expect(german.te(label, 'de'), `${status} in de`).toBe(true);
		}
	});

	it('read in German on a German page', () => {
		const { getStatusBadge } = useCampaignStatusBadge();
		const german = translator('de');
		expect(german.t(getStatusBadge('draft').label)).toBe('Entwurf');
		expect(german.t(getStatusBadge('sent').label)).toBe('Versendet');
	});
});
