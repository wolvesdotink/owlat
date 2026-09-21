/**
 * THE ACCOUNT-DELETION MAIL, IN THE LANGUAGE THE ACCOUNT ASKED FOR.
 *
 * This is the one system email about something irreversible, and it was English
 * regardless of what the recipient had set the product to — down to a
 * `toLocaleDateString('en-US')` that told a German account the deletion date in
 * a format it has to decode. Someone is being asked to act on this mail within
 * 30 days or lose everything, so "they can probably work it out" is not a
 * standard it gets held to.
 *
 * The default is the part worth pinning hardest: an account that never touched
 * the language picker has no `locale`, and it must keep receiving exactly the
 * English mail it received before the field existed.
 */
import { describe, expect, it } from 'vitest';
import { generateDeletionEmailHtml } from '../lib/systemEmails';
import { deletionEmailCopy, systemEmailBcp47, systemEmailLocale } from '../lib/systemEmailCopy';

const SCHEDULED = 'Sunday, June 15, 2025';
const CANCEL_URL = 'https://owlat.test/cancel-deletion?token=abc';

describe('systemEmailLocale', () => {
	it('is English for an account that never picked a language', () => {
		// The whole compatibility promise: absent = today's behaviour, so no
		// existing account's mail changes language on deploy.
		expect(systemEmailLocale(undefined)).toBe('en');
	});

	it('is English for a code this product does not ship', () => {
		// Nothing should be able to put an unrenderable locale on a send path
		// nobody is watching.
		expect(systemEmailLocale('fr')).toBe('en');
		expect(systemEmailLocale('')).toBe('en');
	});

	it('honours a supported language', () => {
		expect(systemEmailLocale('de')).toBe('de');
	});
});

describe('systemEmailBcp47', () => {
	it('names the region, so Intl formats the date the reader expects', () => {
		expect(systemEmailBcp47('en')).toBe('en-US');
		expect(systemEmailBcp47('de')).toBe('de-DE');
	});

	it('produces the locale-appropriate long date', () => {
		const at = Date.UTC(2025, 5, 15, 12);
		const options = {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZone: 'UTC',
		} as const;
		expect(new Date(at).toLocaleDateString(systemEmailBcp47('en'), options)).toBe(
			'Sunday, June 15, 2025'
		);
		expect(new Date(at).toLocaleDateString(systemEmailBcp47('de'), options)).toBe(
			'Sonntag, 15. Juni 2025'
		);
	});
});

describe('generateDeletionEmailHtml', () => {
	it('renders English when no locale is given', () => {
		const html = generateDeletionEmailHtml('ada@example.com', SCHEDULED, CANCEL_URL);
		expect(html).toContain('Account Deletion Scheduled');
		expect(html).toContain('Cancel Account Deletion');
		expect(html).toContain('<html lang="en">');
	});

	it('renders German end to end for a German account', () => {
		const html = generateDeletionEmailHtml('ada@example.com', SCHEDULED, CANCEL_URL, 'de');
		expect(html).toContain('Kontolöschung geplant');
		// Including the CTA and the copy-the-link fallback, which used to be
		// English constants inside the shared button helper.
		expect(html).toContain('Kontolöschung abbrechen');
		expect(html).toContain('Oder kopieren Sie diesen Link in Ihren Browser:');
		expect(html).not.toContain('Cancel Account Deletion');
	});

	it('marks the document language, so a screen reader pronounces it', () => {
		expect(generateDeletionEmailHtml('a@b.test', SCHEDULED, CANCEL_URL, 'de')).toContain(
			'<html lang="de">'
		);
	});

	it('still escapes the recipient address it interpolates', () => {
		// The address reaches this template from a user-controlled profile field.
		const html = generateDeletionEmailHtml('ada+<script>@example.com', SCHEDULED, CANCEL_URL, 'de');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('carries the cancel link in both languages', () => {
		for (const locale of ['en', 'de'] as const) {
			expect(generateDeletionEmailHtml('a@b.test', SCHEDULED, CANCEL_URL, locale)).toContain(
				CANCEL_URL
			);
		}
	});
});

describe('the two catalogs stay in step', () => {
	it('translates every sentence, and lists the same deletions', () => {
		const en = deletionEmailCopy('en');
		const de = deletionEmailCopy('de');
		// A German catalog that quietly lost a bullet would ship a shorter list
		// of what is about to be destroyed.
		expect(de.deletedItems).toHaveLength(en.deletedItems.length);
		expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
		for (const key of ['subject', 'title', 'heading', 'cta', 'footer'] as const) {
			expect(de[key], `${key} is untranslated`).not.toBe(en[key]);
		}
	});

	it('interpolates its two values in both languages', () => {
		expect(deletionEmailCopy('de').scheduledFor('15. Juni 2025')).toContain('15. Juni 2025');
		expect(deletionEmailCopy('de').received('ada@example.com')).toContain('ada@example.com');
	});
});
