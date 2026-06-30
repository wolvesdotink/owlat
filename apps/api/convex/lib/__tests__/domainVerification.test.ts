import { describe, it, expect } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../schema';
import {
	extractDomainFromEmail,
	isDomainVerified,
	validateDomainForSending,
} from '../emailProviders/domainVerification';
import { createTestDomain } from '../../__tests__/factories';

const modules = import.meta.glob('../../**/*.*s');

// ============ Pure function tests ============

describe('extractDomainFromEmail', () => {
	it('extracts domain from simple email address', () => {
		expect(extractDomainFromEmail('user@example.com')).toBe('example.com');
	});

	it('extracts domain from email with name format', () => {
		expect(extractDomainFromEmail('John Doe <john@example.com>')).toBe('example.com');
	});

	it('extracts domain from email with quotes in name', () => {
		expect(extractDomainFromEmail('"John Doe" <john@example.com>')).toBe('example.com');
	});

	it('extracts domain from email with angle brackets only', () => {
		expect(extractDomainFromEmail('<john@example.com>')).toBe('example.com');
	});

	it('lowercases the domain', () => {
		expect(extractDomainFromEmail('user@EXAMPLE.COM')).toBe('example.com');
	});

	it('lowercases domain with mixed case', () => {
		expect(extractDomainFromEmail('user@ExAmPlE.CoM')).toBe('example.com');
	});

	it('extracts subdomain correctly', () => {
		expect(extractDomainFromEmail('user@mail.example.com')).toBe('mail.example.com');
	});

	it('extracts complex subdomain', () => {
		expect(extractDomainFromEmail('user@smtp.mail.example.com')).toBe('smtp.mail.example.com');
	});

	it('throws on missing @ sign', () => {
		expect(() => extractDomainFromEmail('userexample.com')).toThrow('Invalid email address');
	});

	it('extracts the domain after the last @ on multiple @ signs', () => {
		// Now routed through the shared `parseAddress`, which takes the domain
		// after the *last* @ rather than rejecting the (degenerate) input.
		expect(extractDomainFromEmail('user@@example.com')).toBe('example.com');
	});

	it('throws on email with @ at the end', () => {
		expect(() => extractDomainFromEmail('user@')).toThrow('Invalid email address');
	});

	it('throws when @ is at the start (no local part — not an address)', () => {
		// The shared parser requires at least one local-part char before the @,
		// so a leading-@ string is not a parseable address.
		expect(() => extractDomainFromEmail('@example.com')).toThrow('Invalid email address');
	});

	it('throws on empty string', () => {
		expect(() => extractDomainFromEmail('')).toThrow('Invalid email address');
	});

	it('throws on only whitespace', () => {
		expect(() => extractDomainFromEmail('   ')).toThrow('Invalid email address');
	});

	it('throws on angle brackets with no email', () => {
		expect(() => extractDomainFromEmail('John Doe <>')).toThrow('Invalid email address');
	});

	it('throws on malformed angle bracket format', () => {
		expect(() => extractDomainFromEmail('John Doe <invalid>')).toThrow('Invalid email address');
	});

	it('handles uppercase domain in name format', () => {
		expect(extractDomainFromEmail('John <john@EXAMPLE.COM>')).toBe('example.com');
	});

	it('handles domain with numbers', () => {
		expect(extractDomainFromEmail('user@example123.com')).toBe('example123.com');
	});

	it('handles domain with hyphens', () => {
		expect(extractDomainFromEmail('user@my-domain.com')).toBe('my-domain.com');
	});

	it('handles international domain (ascii)', () => {
		expect(extractDomainFromEmail('user@xn--example.com')).toBe('xn--example.com');
	});
});

// ============ Integration tests with Convex DB ============

describe('isDomainVerified', () => {
	it('returns false for non-existent domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const result = await isDomainVerified(ctx.db, 'nonexistent.com');
			expect(result).toBe(false);
		});
	});

	it('returns false for pending domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'pending.com',
					status: 'pending',
				})
			);

			const result = await isDomainVerified(ctx.db, 'pending.com');
			expect(result).toBe(false);
		});
	});

	it('returns false for failed domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'failed.com',
					status: 'failed',
				})
			);

			const result = await isDomainVerified(ctx.db, 'failed.com');
			expect(result).toBe(false);
		});
	});

	it('returns true for verified domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.com',
					status: 'verified',
				})
			);

			const result = await isDomainVerified(ctx.db, 'verified.com');
			expect(result).toBe(true);
		});
	});

	it('is case-insensitive for domain lookup', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'example.com',
					status: 'verified',
				})
			);

			const result = await isDomainVerified(ctx.db, 'EXAMPLE.COM');
			expect(result).toBe(true);
		});
	});

});

describe('validateDomainForSending', () => {
	it('throws for unverified domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await expect(
				validateDomainForSending(ctx.db, 'sender@unverified.com')
			).rejects.toThrow('Cannot send email: domain "unverified.com" is not verified');
		});
	});

	it('throws for pending domain with helpful message', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'pending.com',
					status: 'pending',
				})
			);

			await expect(validateDomainForSending(ctx.db, 'sender@pending.com')).rejects.toThrow(
				'Please verify this domain in Settings > Domains before sending emails'
			);
		});
	});

	it('returns success for verified domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);

			const result = await validateDomainForSending(ctx.db, 'sender@verified.com');

			expect(result.domain).toBe('verified.com');
			expect(result.verified).toBe(true);
			expect(result.warning).toBeUndefined();
		});
	});

	it('extracts domain from name format email', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);

			const result = await validateDomainForSending(
				ctx.db,
				'John Doe <john@verified.com>'
			);

			expect(result.domain).toBe('verified.com');
			expect(result.verified).toBe(true);
		});
	});

	it('is case-insensitive for domain validation', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);

			const result = await validateDomainForSending(ctx.db, 'sender@VERIFIED.COM');

			expect(result.domain).toBe('verified.com');
			expect(result.verified).toBe(true);
		});
	});

	it('returns warning for stale verification', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;

			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'stale.com',
					status: 'verified',
					lastVerifiedAt: twentyFiveHoursAgo,
				})
			);

			const result = await validateDomainForSending(ctx.db, 'sender@stale.com');

			expect(result.verified).toBe(true);
			expect(result.warning).toBeDefined();
			expect(result.warning).toContain('verification is stale');
		});
	});

	it('returns warning when lastVerifiedAt is missing', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'never-checked.com',
					status: 'verified',
					lastVerifiedAt: undefined,
				})
			);

			const result = await validateDomainForSending(ctx.db, 'sender@never-checked.com');

			expect(result.verified).toBe(true);
			expect(result.warning).toBeDefined();
			expect(result.warning).toContain('last checked never');
		});
	});

	it('handles subdomain validation', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'mail.example.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);

			const result = await validateDomainForSending(ctx.db, 'sender@mail.example.com');

			expect(result.domain).toBe('mail.example.com');
			expect(result.verified).toBe(true);
		});
	});

	it('throws for malformed email addresses', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await expect(validateDomainForSending(ctx.db, 'invalid-email')).rejects.toThrow(
				'Invalid email address'
			);
		});
	});

	it('includes domain in error message', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			try {
				await validateDomainForSending(ctx.db, 'sender@test.com');
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain('test.com');
			}
		});
	});
});
