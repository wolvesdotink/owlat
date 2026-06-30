import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestTransactionalEmail } from './factories';
import { assertEditableForPublishableChange } from '../transactional/lifecycle';
import type { Id, Doc } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

// Mock @owlat/email-scanner so tests can drive the scan result deterministically.
// Each test that needs a non-default verdict re-stubs the implementation via
// `(scanContent as Mock).mockReturnValueOnce(...)`. Without an override, scans
// return "clean" — the typical happy-path.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof import('@owlat/email-scanner')>();
	return {
		...original,
		scanContent: vi.fn(() => ({
			score: 0,
			pass: true,
			flags: [],
			level: 'clean' as const,
		})),
	};
});

const { scanContent: mockedScanContent } = await import('@owlat/email-scanner');

// ============================================================================
// create
// ============================================================================

describe('Transactional email lifecycle — create', () => {
	it('inserts a draft row with version fields populated, audit log', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.transactional.lifecycle.create, {
			name: 'Welcome',
			slug: 'welcome-x',
			subject: 'Hello',
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const email = await ctx.db.get(outcome.emailId);
			expect(email?.status).toBe('draft');
			expect(email?.contentBlockVersion).toBeTypeOf('number');
			expect(email?.rendererVersion).toBeTypeOf('number');

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === outcome.emailId));
			expect(audit?.action).toBe('transactional_email.created');
		});
	});

	it('rejects invalid slug format', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.transactional.lifecycle.create, {
			name: 'X',
			slug: 'INVALID SLUG',
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('invalid_slug_format');
	});

	it('rejects duplicate slug', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'dup' })
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.create, {
			name: 'X',
			slug: 'dup',
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('slug_already_exists');
	});
});

// ============================================================================
// transition — happy path: clean scan
// ============================================================================

describe('Transactional email lifecycle — publish with clean scan', () => {
	it('draft → published patches status + publishedAt, audit log', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'clean-pub', status: 'draft' })
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'published', at, htmlContent: '<p>HTML</p>' },
			userId: 'user_pub',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.to).toBe('published');

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('published');
			expect(email?.publishedAt).toBe(at);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === emailId!));
			expect(audit?.action).toBe('transactional_email.published');
		});
	});
});

// ============================================================================
// transition — suspicious scan
// ============================================================================

describe('Transactional email lifecycle — publish with suspicious scan', () => {
	it('routes to pending_review, records scan result, audits as flagged_for_review', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'sus', status: 'draft' })
			);
		});

		// Make scanContent return suspicious for this test only.
		vi.mocked(mockedScanContent).mockReturnValueOnce({
			score: 25,
			pass: false,
			flags: [
				{ type: 'spam_keywords', severity: 'medium', description: 'looks spammy' },
			],
			level: 'suspicious',
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'published', at: Date.now(), htmlContent: '<p>spam</p>' },
			userId: 'user_pub',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('pending_review');

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('pending_review');
			expect(email?.publishedAt).toBeUndefined();
			expect(email?.htmlContent).toBe('<p>spam</p>');

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === emailId!));
			expect(audit?.action).toBe('transactional_email.flagged_for_review');

			const scans = await ctx.db.query('contentScanResults').collect();
			const scan = scans.find((s) => s.resourceId === emailId!);
			expect(scan).toBeDefined();
			expect(scan?.level).toBe('suspicious');
			expect(scan?.score).toBe(25);
		});
	});
});

// ============================================================================
// transition — blocked scan throws
// ============================================================================

describe('Transactional email lifecycle — publish with blocked scan', () => {
	it('throws ConvexError on blocked content, row stays in draft', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'blocked', status: 'draft' })
			);
		});

		vi.mocked(mockedScanContent).mockReturnValueOnce({
			score: 80,
			pass: false,
			flags: [
				{ type: 'phishing_url', severity: 'high', description: 'phishing detected' },
			],
			level: 'blocked',
		});

		await expect(
			t.mutation(internal.transactional.lifecycle.transition, {
				emailId: emailId!,
				input: { to: 'published', at: Date.now(), htmlContent: '<p>bad</p>' },
				userId: 'user_pub',
			})
		).rejects.toThrow();

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('draft');
		});
	});
});

// ============================================================================
// transition — unpublish + idempotency
// ============================================================================

describe('Transactional email lifecycle — unpublish / idempotency', () => {
	it('published → draft clears publishedAt, audits unpublished', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'unpub-test',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_unpub',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('draft');
			expect(email?.publishedAt).toBeUndefined();
		});
	});

	it('draft → draft is idempotent (applied: recorded)', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'idem-draft', status: 'draft' })
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');
	});
});

// ============================================================================
// admin edges: approved / rejected
// ============================================================================

describe('Transactional email lifecycle — admin edges', () => {
	it('pending_review → approved publishes without re-scan', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'approve-me',
					status: 'pending_review',
				})
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'approved', at },
			userId: 'admin_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('published');

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('published');
			expect(email?.publishedAt).toBe(at);

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === emailId!));
			expect(audit?.action).toBe('transactional_email.approved');
		});
	});

	it('pending_review → rejected drops back to draft', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'reject-me',
					status: 'pending_review',
				})
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.transition, {
			emailId: emailId!,
			input: { to: 'rejected', at: Date.now() },
			userId: 'admin_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('draft');

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email?.status).toBe('draft');
			expect(email?.publishedAt).toBeUndefined();

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === emailId!));
			expect(audit?.action).toBe('transactional_email.rejected');
		});
	});
});

// ============================================================================
// duplicate / remove
// ============================================================================

describe('Transactional email lifecycle — duplicate / remove', () => {
	it('duplicate appends -copy[-N] and lands at draft', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Email',
					slug: 'email',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.duplicate, {
			emailId: emailId!,
			userId: 'user_dup',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(outcome.emailId);
			expect(copy?.slug).toBe('email-copy');
			expect(copy?.status).toBe('draft');

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === outcome.emailId));
			expect(audit?.action).toBe('transactional_email.duplicated');
		});
	});

	it('remove deletes row and emits transactional_email.deleted audit', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'gone' })
			);
		});

		const outcome = await t.mutation(internal.transactional.lifecycle.remove, {
			emailId: emailId!,
			userId: 'user_rm',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email).toBeNull();

			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === emailId!));
			expect(audit?.action).toBe('transactional_email.deleted');
		});
	});
});

// ============================================================================
// assertEditableForPublishableChange — pure guard
// ============================================================================

describe('Transactional email — assertEditableForPublishableChange guard', () => {
	const baseEmail = {
		_id: 'kk' as unknown as Id<'transactionalEmails'>,
		_creationTime: 0,
		name: 'T',
		slug: 's',
		subject: 'S',
		content: '[]',
		status: 'draft',
		createdAt: 0,
		updatedAt: 0,
	} as unknown as Doc<'transactionalEmails'>;

	it('does not throw on draft', () => {
		expect(() => assertEditableForPublishableChange(baseEmail)).not.toThrow();
	});

	it('does not throw on pending_review', () => {
		const pending = { ...baseEmail, status: 'pending_review' } as Doc<'transactionalEmails'>;
		expect(() => assertEditableForPublishableChange(pending)).not.toThrow();
	});

	it('throws on published without force', () => {
		const published = { ...baseEmail, status: 'published' } as Doc<'transactionalEmails'>;
		expect(() => assertEditableForPublishableChange(published)).toThrow(ConvexError);
	});

	it('does not throw on published with force: true', () => {
		const published = { ...baseEmail, status: 'published' } as Doc<'transactionalEmails'>;
		expect(() => assertEditableForPublishableChange(published, true)).not.toThrow();
	});
});
