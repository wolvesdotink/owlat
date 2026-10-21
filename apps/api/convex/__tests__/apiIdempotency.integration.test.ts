/**
 * Idempotency-Key on the key-authed send endpoints, end to end through the
 * registered routes (`POST /api/v1/transactional`, `POST /api/v1/events`).
 *
 * The contract pinned here:
 *   - a repeat of a committed keyed request (sequential or concurrent) gets the
 *     same response, marked `Idempotent-Replayed: true`, and no second Send,
 *     counter increment, enqueue, contact or automation run;
 *   - the same key with a different request or endpoint is a 409 with no
 *     effects, and keys of different organizations never meet;
 *   - a request that fails before commit leaves no receipt, so its retry sends;
 *   - a receipt stops answering after its TTL, before or without the sweep;
 *   - a repeat's own attachment uploads are released, the original Send's kept;
 *   - requests without a key behave exactly as before.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';
import type * as GovernedEnqueue from '../delivery/governedEnqueue';
import type * as SessionOrganization from '../lib/sessionOrganization';
import type * as Receipts from '../auth/apiRequestReceipts';
import { RECEIPT_TTL_MS } from '../auth/apiRequestReceipts';
import { readInstanceCounter } from '../lib/instanceCounters';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
	flushScheduled,
} from './factories';

vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

// Counts enqueues, and lets a test make dispatch throw after its writes so the
// transaction rolls back the way a failed commit would.
const enqueue = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../delivery/governedEnqueue', async (importOriginal) => {
	const actual = await importOriginal<typeof GovernedEnqueue>();
	return {
		...actual,
		enqueueGovernedSend: vi.fn(async (...args: Parameters<typeof actual.enqueueGovernedSend>) => {
			if (enqueue.fail) throw new Error('enqueue failed');
			enqueue.calls++;
			return await actual.enqueueGovernedSend(...args);
		}),
	};
});

// The organization the keys are scoped to (the BetterAuth component is not
// registered in this harness).
const org = vi.hoisted(() => ({ id: 'org-a' }));
vi.mock('../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return { ...actual, getSingletonOrganizationId: vi.fn(async () => org.id) };
});

// Lets a test skip the shell's advisory lookup, so the repeat reaches the
// dispatch transaction with its attachments already stored.
const peek = vi.hoisted(() => ({ bypass: false }));
vi.mock('../auth/apiRequestReceipts', async (importOriginal) => {
	const actual = await importOriginal<typeof Receipts>();
	const { internalQuery } = await import('../_generated/server');
	const { v } = await import('convex/values');
	return {
		...actual,
		peekReceipt: internalQuery({
			args: { endpoint: v.any(), idempotency: v.any() },
			handler: async (ctx, args): Promise<Receipts.ReceiptLookup> => {
				if (peek.bypass) return { kind: 'absent' };
				const receipt = await ctx.db
					.query('apiRequestReceipts')
					.withIndex('by_org_key', (q) =>
						q
							.eq('organizationId', args.idempotency.organizationId)
							.eq('idempotencyKey', args.idempotency.key)
					)
					.first();
				return actual.classifyReceipt(
					receipt,
					args.endpoint,
					args.idempotency.requestHash,
					Date.now()
				);
			},
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('posthog') &&
			!p.includes('delivery/worker.ts') &&
			!p.includes('campaigns/testSend') &&
			!p.includes('delivery/workpool') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider') &&
			!p.includes('automationStepExecutor')
	)
);

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['SITE_URL'];
	process.env['OWLAT_DEV_MODE'] = 'true';
	enqueue.fail = false;
	enqueue.calls = 0;
	org.id = 'org-a';
	peek.bypass = false;
});
afterEach(async () => {
	await flushScheduled();
	process.env = { ...SAVED_ENV };
	vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

function setupTest(): T {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const API_KEY = 'lm_live_' + 'b'.repeat(40);

async function seedKey(t: T): Promise<void> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(API_KEY));
	const keyHash = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	await t.run(async (ctx) => {
		await ctx.db.insert('apiKeys', {
			name: 'test-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes: ['transactional:send', 'events:write'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/** A sendable instance with one published template; returns its slug. */
async function seedSendable(t: T): Promise<string> {
	await seedKey(t);
	return await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: 'clean',
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
			})
		);
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() })
		);
		const template = createTestTransactionalEmail({
			status: 'published',
			htmlContent: '<p>Your invoice</p>',
			subject: 'Invoice',
			dataVariablesSchema: { orderNumber: 'string' },
			supportedLanguages: ['en'],
			defaultLanguage: 'en',
		});
		await ctx.db.insert('transactionalEmails', template);
		return template.slug as string;
	});
}

async function post(t: T, path: string, body: unknown, idempotencyKey?: string): Promise<Response> {
	return await t.fetch(path, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
			...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
		},
		body: JSON.stringify(body),
	});
}

const sendRows = (t: T) => t.run((ctx) => ctx.db.query('transactionalSends').collect());
const receiptRows = (t: T) => t.run((ctx) => ctx.db.query('apiRequestReceipts').collect());
const pendingRows = (t: T) => t.run((ctx) => ctx.db.query('transactionalPendingUploads').collect());
const storedBlobs = (t: T) =>
	t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).map((b) => b._id));
const transactionalCount = (t: T) =>
	t.run(async (ctx) => (await readInstanceCounter(ctx.db, 'sends')).transactionalSendCount ?? 0);
const templateSendCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query('transactionalEmails').first())?.sendCount ?? 0);

const KEY = 'order-1001-confirmation';

describe('Idempotency-Key on POST /api/v1/transactional', () => {
	it('replays a repeated request without a second send, counter or enqueue', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com', dataVariables: { orderNumber: 'A-1' } };

		const first = await post(t, '/api/v1/transactional', request, KEY);
		const second = await post(t, '/api/v1/transactional', request, KEY);

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(first.headers.get('Idempotent-Replayed')).toBeNull();
		expect(second.headers.get('Idempotent-Replayed')).toBe('true');
		// Rate-limit and CORS headers are rebuilt for the replay too.
		expect(second.headers.get('X-RateLimit-Limit')).not.toBeNull();
		expect(second.headers.get('Access-Control-Allow-Origin')).not.toBeNull();
		expect(await second.json()).toEqual(await first.json());

		expect(await sendRows(t)).toHaveLength(1);
		expect(await transactionalCount(t)).toBe(1);
		expect(await templateSendCount(t)).toBe(1);
		expect(enqueue.calls).toBe(1);
		const [receipt] = await receiptRows(t);
		expect(receipt).toMatchObject({ organizationId: 'org-a', idempotencyKey: KEY });
		// The receipt keeps ids and flags, never the address or the variables.
		expect(JSON.stringify(receipt)).not.toContain('to@example.com');
		expect(JSON.stringify(receipt)).not.toContain('A-1');
	});

	it('answers concurrent repeats with one send', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com', dataVariables: { orderNumber: 'A-1' } };

		const responses = await Promise.all([
			post(t, '/api/v1/transactional', request, KEY),
			post(t, '/api/v1/transactional', request, KEY),
			post(t, '/api/v1/transactional', request, KEY),
		]);

		const bodies = await Promise.all(responses.map((r) => r.json()));
		expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
		expect(new Set(bodies.map((b) => b.data.transactionalEmailId)).size).toBe(1);
		expect(await sendRows(t)).toHaveLength(1);
		expect(enqueue.calls).toBe(1);
	});

	it('treats key order in the body as the same request', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const first = await post(
			t,
			'/api/v1/transactional',
			{ slug, email: 'to@example.com', dataVariables: { orderNumber: 'A-1' } },
			KEY
		);
		const second = await post(
			t,
			'/api/v1/transactional',
			{ dataVariables: { orderNumber: 'A-1' }, email: 'to@example.com', slug },
			KEY
		);

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(second.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await sendRows(t)).toHaveLength(1);
	});

	it('refuses the same key with a changed payload as a conflict, without effects', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		await post(t, '/api/v1/transactional', { slug, email: 'to@example.com' }, KEY);
		const changed = await post(
			t,
			'/api/v1/transactional',
			{ slug, email: 'other@example.com' },
			KEY
		);

		expect(changed.status).toBe(409);
		const body = await changed.json();
		expect(body.error.category).toBe('conflict');
		expect(body.error.data.reason).toBe('idempotency_conflict');
		expect(await sendRows(t)).toHaveLength(1);
		expect(enqueue.calls).toBe(1);
	});

	it('refuses the same key on another endpoint as a conflict', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		await post(t, '/api/v1/transactional', { slug, email: 'to@example.com' }, KEY);
		const event = await post(
			t,
			'/api/v1/events',
			{ email: 'to@example.com', eventName: 'signed_up', createContactIfNotExists: true },
			KEY
		);

		expect(event.status).toBe(409);
		expect((await event.json()).error.data.reason).toBe('idempotency_conflict');
	});

	it('keeps the keys of different organizations apart', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com' };

		await post(t, '/api/v1/transactional', request, KEY);
		org.id = 'org-b';
		const other = await post(t, '/api/v1/transactional', request, KEY);

		expect(other.status).toBe(202);
		expect(other.headers.get('Idempotent-Replayed')).toBeNull();
		expect(await sendRows(t)).toHaveLength(2);
		expect((await receiptRows(t)).map((r) => r.organizationId).sort()).toEqual(['org-a', 'org-b']);
	});

	it('leaves no receipt when the send fails before commit, so the retry sends', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com' };
		enqueue.fail = true;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const failed = await post(t, '/api/v1/transactional', request, KEY);
		errors.mockRestore();
		expect(failed.status).toBe(500);
		expect(await receiptRows(t)).toHaveLength(0);
		expect(await sendRows(t)).toHaveLength(0);

		enqueue.fail = false;
		const retried = await post(t, '/api/v1/transactional', request, KEY);
		expect(retried.status).toBe(202);
		expect(retried.headers.get('Idempotent-Replayed')).toBeNull();
		expect(await sendRows(t)).toHaveLength(1);
	});

	it('does not store a refused request, so a retry after the fix sends', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const refused = await post(
			t,
			'/api/v1/transactional',
			{ slug: `${slug}-missing`, email: 'to@example.com' },
			KEY
		);
		expect(refused.status).toBe(404);
		expect(await receiptRows(t)).toHaveLength(0);
	});

	it('sends again for a request without a key, as before', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com' };

		await post(t, '/api/v1/transactional', request);
		await post(t, '/api/v1/transactional', request);

		expect(await sendRows(t)).toHaveLength(2);
		expect(await receiptRows(t)).toHaveLength(0);
	});

	it.each([
		['an empty key', ''],
		['a key with a space', 'two words'],
		['an overlong key', 'k'.repeat(256)],
	])('rejects %s with 400 before anything is sent', async (_label, key) => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const res = await post(t, '/api/v1/transactional', { slug, email: 'to@example.com' }, key);

		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Idempotency-Key');
		expect(await sendRows(t)).toHaveLength(0);
	});

	it('stops answering after the TTL even before the sweep, then reuses the key', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com' };

		await post(t, '/api/v1/transactional', request, KEY);
		vi.setSystemTime(Date.now() + RECEIPT_TTL_MS - 1);
		const within = await post(t, '/api/v1/transactional', request, KEY);
		expect(within.headers.get('Idempotent-Replayed')).toBe('true');

		vi.setSystemTime(Date.now() + 2);
		const after = await post(t, '/api/v1/transactional', request, KEY);
		expect(after.status).toBe(202);
		expect(after.headers.get('Idempotent-Replayed')).toBeNull();
		expect(await sendRows(t)).toHaveLength(2);
		// The expired row made way for the new one: one row per key.
		expect(await receiptRows(t)).toHaveLength(1);
	});

	it('sweeps expired receipts in bounded batches and keeps live ones', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		const slug = await seedSendable(t);
		await post(t, '/api/v1/transactional', { slug, email: 'old@example.com' }, 'old-key');
		vi.setSystemTime(Date.now() + RECEIPT_TTL_MS + 1);
		await post(t, '/api/v1/transactional', { slug, email: 'new@example.com' }, 'new-key');

		const swept = await t.mutation(internal.auth.apiRequestReceipts.sweepExpired, {});

		expect(swept).toBe(1);
		expect((await receiptRows(t)).map((r) => r.idempotencyKey)).toEqual(['new-key']);
	});
});

describe('Idempotency-Key and transactional attachments', () => {
	const invoice = {
		filename: 'invoice.pdf',
		content: Buffer.alloc(2048, 0x41).toString('base64'),
		contentType: 'application/pdf',
	};

	it('answers a repeat before storing its attachments again', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com', attachments: [invoice] };

		await post(t, '/api/v1/transactional', request, KEY);
		const original = await storedBlobs(t);
		const replay = await post(t, '/api/v1/transactional', request, KEY);

		expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await storedBlobs(t)).toEqual(original);
	});

	it('releases the uploads of a repeat that reached dispatch and keeps the original blob', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const request = { slug, email: 'to@example.com', attachments: [invoice] };

		await post(t, '/api/v1/transactional', request, KEY);
		const original = await storedBlobs(t);
		const [send] = await sendRows(t);
		expect(send?.attachmentStorageIds).toEqual(original);

		peek.bypass = true;
		const replay = await post(t, '/api/v1/transactional', request, KEY);
		expect(replay.status).toBe(202);
		expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await storedBlobs(t)).toEqual(original);
		expect(await pendingRows(t)).toHaveLength(0);
		expect(await sendRows(t)).toHaveLength(1);

		const conflict = await post(
			t,
			'/api/v1/transactional',
			{ ...request, attachments: [{ ...invoice, filename: 'other.pdf' }] },
			KEY
		);
		expect(conflict.status).toBe(409);
		expect(await storedBlobs(t)).toEqual(original);
		expect(await pendingRows(t)).toHaveLength(0);
	});

	it('counts different attachment bytes as a different request', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		await post(
			t,
			'/api/v1/transactional',
			{ slug, email: 'to@example.com', attachments: [invoice] },
			KEY
		);
		const changed = await post(
			t,
			'/api/v1/transactional',
			{
				slug,
				email: 'to@example.com',
				attachments: [{ ...invoice, content: Buffer.alloc(2048, 0x42).toString('base64') }],
			},
			KEY
		);

		expect(changed.status).toBe(409);
	});
});

describe('Idempotency-Key on POST /api/v1/events', () => {
	async function seedEventAutomation(t: T): Promise<void> {
		await seedKey(t);
		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 0 })
			);
		});
	}

	const contacts = (t: T) => t.run((ctx) => ctx.db.query('contacts').collect());
	const runs = (t: T) => t.run((ctx) => ctx.db.query('automationRuns').collect());

	it('creates the contact and fans out once for a repeated request', async () => {
		const t = setupTest();
		await seedEventAutomation(t);
		const request = {
			email: 'buyer@example.com',
			eventName: 'purchase',
			eventProperties: { amount: 42 },
			createContactIfNotExists: true,
		};

		const first = await post(t, '/api/v1/events', request, KEY);
		const second = await post(t, '/api/v1/events', request, KEY);

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(second.headers.get('Idempotent-Replayed')).toBe('true');
		const firstBody = await first.json();
		expect(await second.json()).toEqual(firstBody);
		expect(firstBody.data).toMatchObject({ contactCreated: true, triggeredAutomations: 1 });
		expect(await contacts(t)).toHaveLength(1);
		expect(await runs(t)).toHaveLength(1);
	});

	it('writes the API-key audit row for a contact it creates', async () => {
		const t = setupTest();
		await seedEventAutomation(t);

		await post(
			t,
			'/api/v1/events',
			{ email: 'Buyer@Example.com', eventName: 'purchase', createContactIfNotExists: true },
			KEY
		);

		const audits = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audits.filter((a) => a.action === 'contact.created')).toEqual([
			expect.objectContaining({ userId: 'api', details: { email: 'buyer@example.com' } }),
		]);
	});

	it('refuses the same key with changed properties as a conflict, without effects', async () => {
		const t = setupTest();
		await seedEventAutomation(t);
		await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'buyer@example.com' }))
		);

		await post(t, '/api/v1/events', { email: 'buyer@example.com', eventName: 'purchase' }, KEY);
		const changed = await post(
			t,
			'/api/v1/events',
			{ email: 'buyer@example.com', eventName: 'purchase', eventProperties: { amount: 1 } },
			KEY
		);

		expect(changed.status).toBe(409);
		expect(await runs(t)).toHaveLength(1);
	});

	it('treats an omitted createContactIfNotExists like false', async () => {
		const t = setupTest();
		await seedEventAutomation(t);
		await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'buyer@example.com' }))
		);

		await post(t, '/api/v1/events', { email: 'buyer@example.com', eventName: 'purchase' }, KEY);
		const explicit = await post(
			t,
			'/api/v1/events',
			{ email: 'buyer@example.com', eventName: 'purchase', createContactIfNotExists: false },
			KEY
		);

		expect(explicit.status).toBe(201);
		expect(explicit.headers.get('Idempotent-Replayed')).toBe('true');
	});

	it('still answers 404 for a missing contact and stores nothing', async () => {
		const t = setupTest();
		await seedEventAutomation(t);

		const res = await post(
			t,
			'/api/v1/events',
			{ email: 'nobody@example.com', eventName: 'purchase' },
			KEY
		);

		expect(res.status).toBe(404);
		expect((await res.json()).error.category).toBe('not_found');
		expect(await receiptRows(t)).toHaveLength(0);
	});

	it('fires again for a request without a key, as before', async () => {
		const t = setupTest();
		await seedEventAutomation(t);
		await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'buyer@example.com' }))
		);
		const request = { email: 'buyer@example.com', eventName: 'purchase' };

		const first = await post(t, '/api/v1/events', request);
		// The first run is still running, so the fanout guard skips the second.
		await t.run(async (ctx) => {
			for (const run of await ctx.db.query('automationRuns').collect()) {
				await ctx.db.patch(run._id, { status: 'completed' });
			}
		});
		const second = await post(t, '/api/v1/events', request);

		expect((await first.json()).data.eventId).not.toBe((await second.json()).data.eventId);
		expect(await runs(t)).toHaveLength(2);
	});
});
