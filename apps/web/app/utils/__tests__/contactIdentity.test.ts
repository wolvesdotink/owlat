/**
 * contactPrimaryIdentity (plan OW-037): a contact's list label is its email,
 * else its full name, else the localized "Unnamed contact"; never empty, never
 * a made-up email.
 */
import { describe, expect, it } from 'vitest';
import de from '~~/i18n/locales/de.json';
import { contactHasEmail, contactPrimaryIdentity } from '../contactIdentity';
import { createTestI18n } from '~/__tests__/i18n';

const t = createTestI18n().global.t;

describe('contactPrimaryIdentity', () => {
	it('uses the email when the contact has one, even with a name', () => {
		expect(contactPrimaryIdentity({ email: 'ada@example.com' }, t)).toBe('ada@example.com');
		expect(
			contactPrimaryIdentity({ email: 'ada@example.com', firstName: 'Ada', lastName: 'L' }, t)
		).toBe('ada@example.com');
	});

	it('falls back to the full name for a named email-less contact', () => {
		expect(contactPrimaryIdentity({ firstName: 'Ada', lastName: 'Lovelace' }, t)).toBe(
			'Ada Lovelace'
		);
		expect(contactPrimaryIdentity({ email: '', firstName: 'Ada' }, t)).toBe('Ada');
		expect(contactPrimaryIdentity({ email: null, lastName: 'Lovelace' }, t)).toBe('Lovelace');
		expect(contactPrimaryIdentity({ firstName: '  ', lastName: ' Lovelace ' }, t)).toBe('Lovelace');
	});

	it('falls back to the localized unnamed label when there is no email or name', () => {
		expect(contactPrimaryIdentity({}, t)).toBe('Unnamed contact');
		expect(contactPrimaryIdentity({ email: '  ', firstName: '', lastName: null }, t)).toBe(
			'Unnamed contact'
		);
	});

	it('is never empty and never invents an email', () => {
		const cases = [
			{ email: 'ada@example.com' },
			{ firstName: 'Ada' },
			{ email: undefined, firstName: null, lastName: null },
		];
		for (const contact of cases) {
			const label = contactPrimaryIdentity(contact, t);
			expect(label.trim()).not.toBe('');
			if (!contact.email) expect(label).not.toContain('@');
		}
	});

	it('has the unnamed label in every locale', () => {
		expect(de.dashboard.audience.contacts.index.unnamedContact).toBe('Unbenannter Kontakt');
	});
});

describe('contactHasEmail', () => {
	it('is true only for a nonblank email', () => {
		expect(contactHasEmail({ email: 'ada@example.com' })).toBe(true);
		expect(contactHasEmail({ email: '  ' })).toBe(false);
		expect(contactHasEmail({ email: null, firstName: 'Ada' })).toBe(false);
		expect(contactHasEmail({})).toBe(false);
	});
});
