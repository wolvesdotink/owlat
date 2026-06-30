import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	screenContent,
	addToUrlBlocklist,
	removeFromUrlBlocklist,
	getUrlBlocklist,
} from '../contentScreening.js';
import { createTestEmailJob, createTestConfig } from '../../__tests__/helpers/fixtures.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('contentScreening', () => {
	let redis: RealRedis;
	const config = createTestConfig();

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('screenContent', () => {
		it('rejects empty body (no html, no text)', async () => {
			const job = createTestEmailJob({ html: '', text: undefined });
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe('empty_body');
		});

		it('allows when html is present', async () => {
			const job = createTestEmailJob({ html: '<p>Hello</p>' });
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(true);
		});

		it('rejects missing from', async () => {
			const job = createTestEmailJob({ from: '' });
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe('missing_from');
		});

		it('rejects missing subject', async () => {
			const job = createTestEmailJob({ subject: '' });
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe('missing_subject');
		});

		describe('DKIM alignment', () => {
			it('allows exact domain match', async () => {
				const job = createTestEmailJob({
					from: 'sender@example.com',
					dkimDomain: 'example.com',
				});
				const result = await screenContent(redis, job, config);
				expect(result.allowed).toBe(true);
			});

			it('allows when from is subdomain of dkim', async () => {
				const job = createTestEmailJob({
					from: 'sender@notifications.example.com',
					dkimDomain: 'example.com',
				});
				const result = await screenContent(redis, job, config);
				expect(result.allowed).toBe(true);
			});

			it('allows when dkim is subdomain of from', async () => {
				const job = createTestEmailJob({
					from: 'sender@example.com',
					dkimDomain: 'mail.example.com',
				});
				const result = await screenContent(redis, job, config);
				expect(result.allowed).toBe(true);
			});

			it('rejects DKIM misalignment', async () => {
				const job = createTestEmailJob({
					from: 'sender@example.com',
					dkimDomain: 'otherdomain.com',
				});
				const result = await screenContent(redis, job, config);
				expect(result.allowed).toBe(false);
				expect(result.reason).toBe('dkim_misalignment');
			});

			it('handles "Name <email>" format in from', async () => {
				const job = createTestEmailJob({
					from: 'John Doe <sender@example.com>',
					dkimDomain: 'example.com',
				});
				const result = await screenContent(redis, job, config);
				expect(result.allowed).toBe(true);
			});

			// PR-27 — Regression-lock the DKIM-alignment decision table that gates
			// outbound through screenContent(). DMARC (RFC 7489 §3.1.1) passes only
			// when the DKIM d= aligns with the RFC5322.From domain (exact or
			// organizational/subdomain under relaxed alignment); a misaligned d=
			// signs valid mail that still fails DMARC at Gmail/Yahoo. This pins the
			// three canonical rows so a refactor of isDomainAligned trips here.
			describe('alignment decision table (RFC 7489 §3.1.1)', () => {
				const cases: Array<{
					name: string;
					from: string;
					dkimDomain: string;
					allowed: boolean;
					reason?: string;
				}> = [
					{
						name: 'subdomain From under the dkim org domain is aligned',
						from: 'sender@mail.example.com',
						dkimDomain: 'example.com',
						allowed: true,
					},
					{
						name: 'exact match is aligned',
						from: 'sender@example.com',
						dkimDomain: 'example.com',
						allowed: true,
					},
					{
						name: 'unrelated dkim domain is a misalignment',
						from: 'sender@evil.com',
						dkimDomain: 'example.com',
						allowed: false,
						reason: 'dkim_misalignment',
					},
				];

				for (const c of cases) {
					it(c.name, async () => {
						const job = createTestEmailJob({ from: c.from, dkimDomain: c.dkimDomain });
						const result = await screenContent(redis, job, config);
						expect(result.allowed).toBe(c.allowed);
						if (c.reason) {
							expect(result.reason).toBe(c.reason);
						} else {
							expect(result.reason).toBeUndefined();
						}
					});
				}
			});
		});

		it('rejects content too large', async () => {
			const smallConfig = createTestConfig({ contentMaxSizeKb: 1 }); // 1KB limit
			const largeHtml = '<p>' + 'x'.repeat(2048) + '</p>';
			const job = createTestEmailJob({ html: largeHtml });

			const result = await screenContent(redis, job, smallConfig);
			expect(result.allowed).toBe(false);
			expect(result.reason).toMatch(/^content_too_large:/);
		});

		it('rejects when URL matches blocklist', async () => {
			await addToUrlBlocklist(redis, 'malware.evil.com');

			const job = createTestEmailJob({
				html: '<a href="https://malware.evil.com/payload">Click</a>',
			});
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe('blocked_url:malware.evil.com');
		});

		it('allows when no URLs match blocklist', async () => {
			await addToUrlBlocklist(redis, 'malware.evil.com');

			const job = createTestEmailJob({
				html: '<a href="https://safe.example.com">Click</a>',
			});
			const result = await screenContent(redis, job, config);
			expect(result.allowed).toBe(true);
		});
	});

	describe('URL blocklist CRUD', () => {
		it('addToUrlBlocklist adds a pattern', async () => {
			await addToUrlBlocklist(redis, 'spam.example.com');
			const list = await getUrlBlocklist(redis);
			expect(list).toContain('spam.example.com');
		});

		it('removeFromUrlBlocklist removes a pattern', async () => {
			await addToUrlBlocklist(redis, 'spam.example.com');
			await removeFromUrlBlocklist(redis, 'spam.example.com');
			const list = await getUrlBlocklist(redis);
			expect(list).not.toContain('spam.example.com');
		});

		it('getUrlBlocklist returns all patterns', async () => {
			await addToUrlBlocklist(redis, 'bad1.com');
			await addToUrlBlocklist(redis, 'bad2.com');
			await addToUrlBlocklist(redis, 'bad3.com');

			const list = await getUrlBlocklist(redis);
			expect(list).toHaveLength(3);
			expect(list).toContain('bad1.com');
			expect(list).toContain('bad2.com');
			expect(list).toContain('bad3.com');
		});
	});
});
