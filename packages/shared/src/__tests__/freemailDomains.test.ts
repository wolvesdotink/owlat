import { describe, expect, it } from 'vitest';
import { isFreemailDomain } from '../freemailDomains';

describe('isFreemailDomain', () => {
	it('flags shared mailbox providers, including brand ccTLD variants', () => {
		for (const domain of ['gmail.com', 'Outlook.com.', 'posteo.de', 'gmx.at', 'yahoo.fr']) {
			expect(isFreemailDomain(domain)).toBe(true);
		}
	});

	it('leaves organisational domains alone', () => {
		for (const domain of ['acme-bank.com', 'mail.google.dev', 'gmailer.com', 'com', '']) {
			expect(isFreemailDomain(domain)).toBe(false);
		}
	});
});
