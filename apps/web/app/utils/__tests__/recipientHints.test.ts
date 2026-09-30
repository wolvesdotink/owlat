/**
 * Pure recipient-hint helpers (utils/recipientHints):
 *   - external-domain detection (subdomains of an own domain count internal)
 *   - reply-all-gap derivation (participants minus sender and self)
 */
import { describe, it, expect } from 'vitest';
import {
	isExternalRecipient,
	ownDomainsFromIdentities,
	deriveReplyAllExtras,
	mergeRecipients,
	messageRecipientNames,
	recipientLabel,
} from '../recipientHints';

describe('isExternalRecipient', () => {
	const own = ['example.com'];
	it('treats the exact own domain as internal', () => {
		expect(isExternalRecipient('anna@example.com', own)).toBe(false);
	});
	it('treats a subdomain of an own domain as internal', () => {
		expect(isExternalRecipient('ops@mail.example.com', own)).toBe(false);
	});
	it('flags a different domain as external', () => {
		expect(isExternalRecipient('vendor@acme.io', own)).toBe(true);
	});
	it('does not treat a lookalike suffix as internal', () => {
		expect(isExternalRecipient('x@notexample.com', own)).toBe(true);
	});
	it('is non-committal (never external) when no own domains are known', () => {
		expect(isExternalRecipient('anyone@anywhere.com', [])).toBe(false);
	});
});

describe('ownDomainsFromIdentities', () => {
	it('dedupes the domains of the identity addresses', () => {
		expect(
			ownDomainsFromIdentities(['me@example.com', 'sales@example.com', 'me@alias.io'])
		).toEqual(['example.com', 'alias.io']);
	});
});

describe('deriveReplyAllExtras', () => {
	const source = {
		fromAddress: 'sender@acme.io',
		toAddresses: ['me@example.com', 'anna@acme.io'],
		ccAddresses: ['ben@acme.io', 'me@example.com'],
	};
	it('returns To/Cc participants minus the sender and self, deduped', () => {
		expect(deriveReplyAllExtras(source, ['me@example.com'])).toEqual([
			'anna@acme.io',
			'ben@acme.io',
		]);
	});
	it('excludes the original sender even when also listed in To', () => {
		expect(
			deriveReplyAllExtras(
				{ fromAddress: 'anna@acme.io', toAddresses: ['anna@acme.io'], ccAddresses: [] },
				['me@example.com']
			)
		).toEqual([]);
	});
	it('is case-insensitive and unwraps display framing', () => {
		expect(
			deriveReplyAllExtras(
				{
					fromAddress: 'S@acme.io',
					toAddresses: ['Anna <ANNA@acme.io>'],
					ccAddresses: ['anna@acme.io'],
				},
				[]
			)
		).toEqual(['Anna <ANNA@acme.io>']);
	});
});

describe('mergeRecipients', () => {
	it('appends additions, deduping against existing and exclude by canonical key', () => {
		expect(
			mergeRecipients(
				['ben@acme.io'],
				['Anna <ANNA@acme.io>', 'ben@acme.io', 'me@example.com'],
				['me@example.com']
			)
		).toEqual(['ben@acme.io', 'Anna <ANNA@acme.io>']);
	});
	it('preserves existing order first and skips blank additions', () => {
		expect(mergeRecipients(['a@x.io'], ['', '  ', 'b@x.io'])).toEqual(['a@x.io', 'b@x.io']);
	});
});

describe('recipientLabel', () => {
	it('prefers the display name, falling back to the local part', () => {
		expect(recipientLabel('Anna Smith <anna@acme.io>')).toBe('Anna Smith');
		expect(recipientLabel('ben@acme.io')).toBe('ben');
	});

	it('names a bare address the thread knows, by its canonical form', () => {
		const names = { 'finance@brightpath.example': 'Jonas Berg' };
		expect(recipientLabel('finance@brightpath.example', names)).toBe('Jonas Berg');
		expect(recipientLabel('Finance@Brightpath.example', names)).toBe('Jonas Berg');
		// A name on the address itself still wins; strangers keep the local part.
		expect(recipientLabel('Accounts <finance@brightpath.example>', names)).toBe('Accounts');
		expect(recipientLabel('ben@acme.io', names)).toBe('ben');
	});
});

describe('messageRecipientNames', () => {
	it("maps the sender's name and the named To/Cc people by address", () => {
		expect(
			messageRecipientNames({
				fromAddress: 'finance@brightpath.example',
				fromName: 'Jonas Berg',
				toAddresses: ['Ada Lovelace <ada@northwind.example>', 'ops@northwind.example'],
				ccAddresses: ['"Priya N." <priya@brightpath.example>'],
			})
		).toEqual({
			'finance@brightpath.example': 'Jonas Berg',
			'ada@northwind.example': 'Ada Lovelace',
			'priya@brightpath.example': 'Priya N.',
		});
	});

	it('has nothing for a sender without a name', () => {
		expect(messageRecipientNames({ fromAddress: 'finance@brightpath.example' })).toEqual({});
	});
});
