import { describe, it, expect } from 'vitest';
import {
	scanSenderImpersonation,
	extractHeaderDomain,
	registrableDomain,
} from '../content/senderImpersonation.js';
import { scanContent } from '../content/index.js';

describe('sender-impersonation detection', () => {
	describe('extractHeaderDomain', () => {
		it('reads a bare address', () => {
			expect(extractHeaderDomain('alice@example.com')).toBe('example.com');
		});
		it('reads an angle-addr with a display name', () => {
			expect(extractHeaderDomain('Alice <alice@Example.COM>')).toBe('example.com');
		});
		it('returns undefined when there is no @domain', () => {
			expect(extractHeaderDomain('not-an-address')).toBeUndefined();
		});
	});

	describe('registrableDomain', () => {
		it('folds a subdomain to its registrable form', () => {
			expect(registrableDomain('mail.paypal.com')).toBe('paypal.com');
			expect(registrableDomain('paypal.com')).toBe('paypal.com');
		});
	});

	describe('scanSenderImpersonation', () => {
		it('flags a punycode / IDN From domain', () => {
			// xn--pypal-4ve.com — a punycode label in the sender domain.
			const flags = scanSenderImpersonation('Billing <billing@xn--pypal-4ve.com>');
			expect(flags.length).toBeGreaterThan(0);
			const flag = flags.find((f) => f.type === 'sender_impersonation');
			expect(flag).toBeDefined();
			expect(flag!.match).toBe('xn--pypal-4ve.com');
		});

		it('flags a mixed-script homoglyph From domain', () => {
			// "paypаl.com" — Cyrillic а (U+0430) mimicking Latin a.
			const domain = `paypаl.com`;
			const flags = scanSenderImpersonation(`Support <support@${domain}>`);
			const flag = flags.find((f) => f.type === 'sender_impersonation');
			expect(flag).toBeDefined();
			expect(flag!.severity).toBe('high');
			// Deconfuses back to the Latin look-alike.
			expect(flag!.description).toContain('paypal.com');
		});

		it('flags a Reply-To on a different domain than From', () => {
			const flags = scanSenderImpersonation('billing@paypal.com', 'attacker@evil.example');
			const flag = flags.find((f) => f.type === 'reply_to_mismatch');
			expect(flag).toBeDefined();
			expect(flag!.match).toBe('evil.example');
		});

		it('does NOT flag a Reply-To that is a subdomain of the same org', () => {
			const flags = scanSenderImpersonation('newsletter@mail.paypal.com', 'support@paypal.com');
			expect(flags.find((f) => f.type === 'reply_to_mismatch')).toBeUndefined();
		});

		it('is clean for an ordinary ASCII sender with matching Reply-To', () => {
			const flags = scanSenderImpersonation('Alice <alice@example.com>', 'alice@example.com');
			expect(flags).toHaveLength(0);
		});

		it('is clean when no headers are supplied', () => {
			expect(scanSenderImpersonation()).toHaveLength(0);
			expect(scanSenderImpersonation(undefined, 'x@y.com')).toHaveLength(0);
		});
	});

	describe('via scanContent (registry integration)', () => {
		it('raises sender_impersonation through the full scan when headers are passed', () => {
			const domain = `paypаl.com`;
			const result = scanContent('Invoice', '<p>hello</p>', {
				from: `billing@${domain}`,
				replyTo: 'attacker@evil.example',
			});
			const types = result.flags.map((f) => f.type);
			expect(types).toContain('sender_impersonation');
			expect(types).toContain('reply_to_mismatch');
		});

		it('no-ops the header rule when scanContent is called without headers', () => {
			const result = scanContent('Hello', '<p>ordinary content</p>');
			expect(result.flags.find((f) => f.type === 'sender_impersonation')).toBeUndefined();
			expect(result.flags.find((f) => f.type === 'reply_to_mismatch')).toBeUndefined();
		});
	});
});
