/**
 * Attachment intake of POST /api/v1/transactional, end to end through the
 * registered HTTP route (auth, the route's body ceiling, validation, storage,
 * the pending-upload handoff and the dispatch mutation).
 *
 * Two properties are pinned here:
 *   - stored attachment bytes never outlive a refused request: validation runs
 *     over the whole list before anything is stored, and every rejection or
 *     thrown dispatch releases what was stored, while a queued Send keeps its
 *     blob;
 *   - the documented attachment budget is reachable: a 100 KiB file and the
 *     10 MiB boundary go through, while every other endpoint keeps its
 *     100,000-byte body cap.
 *
 * See docs/adr/0021-transactional-send-intake-module.md (amendment 2026-10-01).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as GovernedEnqueue from '../delivery/governedEnqueue';
import type { MutationCtx } from '../_generated/server';
import {
	claimPendingUploads,
	DELETE_RETRY_BASE_MS,
	MAX_DELETE_ATTEMPTS,
	PENDING_UPLOAD_TTL_MS,
	release,
	sweepExpired,
} from '../transactional/pendingUploads';
import { TRANSACTIONAL_MAX_BODY_BYTES } from '../transactional/api';
import {
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from './factories';

vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

// Lets a test make the dispatch mutation throw AFTER it inserted the Send, so
// the transaction rolls back the way a failed commit would.
const enqueueFault = vi.hoisted(() => ({ fail: false }));
vi.mock('../delivery/governedEnqueue', async (importOriginal) => {
	const actual = await importOriginal<typeof GovernedEnqueue>();
	return {
		...actual,
		enqueueGovernedSend: vi.fn(async (...args: Parameters<typeof actual.enqueueGovernedSend>) => {
			if (enqueueFault.fail) throw new Error('enqueue failed');
			return await actual.enqueueGovernedSend(...args);
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
			!p.includes('llmProvider')
	)
);

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['SITE_URL'];
	process.env['OWLAT_DEV_MODE'] = 'true';
	enqueueFault.fail = false;
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
	vi.useRealTimers();
});

function setupTest(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const API_KEY = 'lm_live_' + 'a'.repeat(40);

async function seedKey(t: TestConvex<typeof schema>): Promise<void> {
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
			scopes: ['transactional:send', 'contacts:write'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedSendable(
	t: TestConvex<typeof schema>,
	overrides: { domainStatus?: 'verified' | 'pending' } = {}
): Promise<string> {
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
			createTestDomain({
				domain: 'example.com',
				status: overrides.domainStatus ?? 'verified',
				lastVerifiedAt: Date.now(),
			})
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

function base64Of(byteLength: number, fill = 0x41): string {
	return Buffer.alloc(byteLength, fill).toString('base64');
}

async function post(t: TestConvex<typeof schema>, path: string, body: string): Promise<Response> {
	return await t.fetch(path, {
		method: 'POST',
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body,
	});
}

async function sendTransactional(t: TestConvex<typeof schema>, body: unknown): Promise<Response> {
	return await post(t, '/api/v1/transactional', JSON.stringify(body));
}

async function storedBlobs(t: TestConvex<typeof schema>): Promise<Id<'_storage'>[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_storage').collect()).map((blob) => blob._id)
	);
}

async function pendingRows(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => await ctx.db.query('transactionalPendingUploads').collect());
}

async function sendRows(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => await ctx.db.query('transactionalSends').collect());
}

const invoice = {
	filename: 'invoice.pdf',
	content: base64Of(2048),
	contentType: 'application/pdf',
};

describe('transactional attachment intake — nothing outlives a refused request', () => {
	it('rejects an invalid second attachment before storing the valid first one', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [invoice, { filename: 'bad/name.pdf', content: base64Of(16) }],
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('attachments[1].filename');
		expect(await storedBlobs(t)).toHaveLength(0);
		expect(await pendingRows(t)).toHaveLength(0);
	});

	it('rejects undecodable base64 in a later attachment without storing anything', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			attachments: [invoice, { filename: 'b.bin', content: '***not base64***' }],
		});

		expect(res.status).toBe(400);
		expect(await storedBlobs(t)).toHaveLength(0);
	});

	it.each([
		['template_not_found', 404, (slug: string) => ({ slug: `${slug}-missing` })],
		['invalid_variables', 400, () => ({ dataVariables: { orderNumber: 42 } })],
	] as const)(
		'releases the stored blob when dispatch refuses with %s',
		async (reason, status, extra) => {
			const t = setupTest();
			const slug = await seedSendable(t);

			const res = await sendTransactional(t, {
				slug,
				email: 'to@example.com',
				dataVariables: { orderNumber: 'A-1' },
				attachments: [invoice, { filename: 'terms.pdf', content: base64Of(512) }],
				...extra(slug),
			});

			expect(res.status).toBe(status);
			expect((await res.json()).error.data?.reason).toBe(reason);
			expect(await storedBlobs(t)).toHaveLength(0);
			expect(await pendingRows(t)).toHaveLength(0);
			expect(await sendRows(t)).toHaveLength(0);
		}
	);

	it('releases the stored blob when the sending domain is not verified', async () => {
		const t = setupTest();
		const slug = await seedSendable(t, { domainStatus: 'pending' });

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [invoice],
		});

		expect(res.status).toBe(422);
		expect((await res.json()).error.data?.reason).toBe('domain_unverified');
		expect(await storedBlobs(t)).toHaveLength(0);
	});

	it('releases the stored blob when the dispatch mutation throws', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		enqueueFault.fail = true;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [invoice],
		});
		errors.mockRestore();

		expect(res.status).toBe(500);
		expect(await sendRows(t)).toHaveLength(0);
		expect(await storedBlobs(t)).toHaveLength(0);
		expect(await pendingRows(t)).toHaveLength(0);
	});

	it('keeps the blob of a queued send and hands its ownership to the Send row', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [invoice, { filename: 'remote.pdf', url: 'https://files.example.com/r.pdf' }],
		});

		expect(res.status).toBe(202);
		const blobs = await storedBlobs(t);
		expect(blobs).toHaveLength(1);
		const [send] = await sendRows(t);
		expect(send?.attachmentStorageIds).toEqual(blobs);
		// Claimed in the insert's transaction: nothing is left for a release or
		// the expiry sweep to delete.
		expect(await pendingRows(t)).toHaveLength(0);
	});
});

describe('transactional pending uploads — release, claim and expiry', () => {
	async function storeBlob(t: TestConvex<typeof schema>): Promise<Id<'_storage'>> {
		return await t.run(async (ctx) => await ctx.storage.store(new Blob(['bytes'])));
	}

	it('a release never deletes a blob whose pending row was claimed', async () => {
		const t = setupTest();
		const claimed = await storeBlob(t);
		const unclaimed = await storeBlob(t);
		await t.mutation(internal.transactional.pendingUploads.register, { storageId: claimed });
		await t.mutation(internal.transactional.pendingUploads.register, { storageId: unclaimed });
		await t.run(async (ctx) => await claimPendingUploads(ctx, [claimed]));

		const released = await t.mutation(internal.transactional.pendingUploads.release, {
			storageIds: [claimed, unclaimed],
		});

		expect(released).toBe(1);
		expect(await storedBlobs(t)).toEqual([claimed]);
	});

	it('dispatch refuses to queue a send whose upload is no longer pending', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const storageId = await storeBlob(t);

		await expect(
			t.mutation(internal.transactional.dispatch.dispatch, {
				templateLookup: { kind: 'slug', slug },
				email: 'to@example.com',
				dataVariables: { orderNumber: 'A-1' },
				attachmentRefs: [
					{ filename: 'a.pdf', url: 'https://files.example.com/a', storageId: storageId },
				],
				uploadsPending: true,
			})
		).rejects.toThrow(/no longer pending/);
		expect(await sendRows(t)).toHaveLength(0);
	});

	it('the expiry sweep frees abandoned uploads and leaves fresh ones', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		const abandoned = await storeBlob(t);
		await t.mutation(internal.transactional.pendingUploads.register, { storageId: abandoned });
		vi.setSystemTime(Date.now() + PENDING_UPLOAD_TTL_MS + 1);
		const fresh = await storeBlob(t);
		await t.mutation(internal.transactional.pendingUploads.register, { storageId: fresh });

		await t.mutation(internal.transactional.pendingUploads.sweepExpired, {});

		expect(await storedBlobs(t)).toEqual([fresh]);
		expect((await pendingRows(t)).map((row) => row.storageId)).toEqual([fresh]);
	});
});

describe('transactional pending uploads — a failed blob deletion keeps its owner', () => {
	type Handler = (ctx: MutationCtx, args: unknown) => Promise<unknown>;

	/**
	 * Run a registered mutation's handler in a convex-test transaction whose
	 * `storage.delete` rejects for the given blobs, the way a temporary storage
	 * outage would. Every other storage call goes through.
	 */
	async function runWithFailingDeletes(
		t: TestConvex<typeof schema>,
		registered: unknown,
		args: unknown,
		failing: readonly Id<'_storage'>[]
	): Promise<unknown> {
		const handler = (registered as { _handler: Handler })._handler;
		return await t.run(async (ctx) => {
			const storage = {
				...ctx.storage,
				delete: async (storageId: Id<'_storage'>) => {
					if (failing.includes(storageId)) throw new Error('storage temporarily unavailable');
					await ctx.storage.delete(storageId);
				},
			};
			return await handler({ ...ctx, storage } as unknown as MutationCtx, args);
		});
	}

	async function registerBlob(t: TestConvex<typeof schema>): Promise<Id<'_storage'>> {
		const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['bytes'])));
		await t.mutation(internal.transactional.pendingUploads.register, { storageId });
		return storageId;
	}

	it('a release whose deletion fails keeps the row, so the sweep can still free the blob', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		const stuck = await registerBlob(t);
		const freed = await registerBlob(t);

		const released = await runWithFailingDeletes(t, release, { storageIds: [stuck, freed] }, [
			stuck,
		]);

		expect(released).toBe(1);
		expect(await storedBlobs(t)).toEqual([stuck]);
		const [row] = await pendingRows(t);
		expect(row?.storageId).toBe(stuck);
		expect(row?.deleteAttempts).toBe(1);

		// The upload is no longer claimable while its deletion is outstanding.
		await expect(t.run(async (ctx) => await claimPendingUploads(ctx, [stuck]))).rejects.toThrow(
			/no longer pending/
		);

		// Storage recovers; the next sweep after the backoff frees the blob.
		vi.setSystemTime(Date.now() + DELETE_RETRY_BASE_MS + 1);
		await t.mutation(internal.transactional.pendingUploads.sweepExpired, {});
		expect(await storedBlobs(t)).toEqual([]);
		expect(await pendingRows(t)).toEqual([]);
	});

	it('an expiry sweep whose deletion fails keeps that row and still frees the rest of the batch', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		await registerBlob(t);
		const stuck = await registerBlob(t);
		await registerBlob(t);
		vi.setSystemTime(Date.now() + PENDING_UPLOAD_TTL_MS + 1);

		await runWithFailingDeletes(t, sweepExpired, {}, [stuck]);

		expect(await storedBlobs(t)).toEqual([stuck]);
		const rows = await pendingRows(t);
		expect(rows.map((row) => row.storageId)).toEqual([stuck]);
		expect(rows[0]?.deleteAttempts).toBe(1);
		// Out of the current window, so an immediate rerun leaves it alone.
		expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now());

		vi.setSystemTime(Date.now() + DELETE_RETRY_BASE_MS + 1);
		await t.mutation(internal.transactional.pendingUploads.sweepExpired, {});
		expect(await storedBlobs(t)).toEqual([]);
		expect(await pendingRows(t)).toEqual([]);
	});

	it('a deletion already done before the failure counts as freed', async () => {
		const t = setupTest();
		const gone = await registerBlob(t);
		await t.run(async (ctx) => await ctx.storage.delete(gone));

		const released = await runWithFailingDeletes(t, release, { storageIds: [gone] }, [gone]);

		expect(released).toBe(1);
		expect(await pendingRows(t)).toEqual([]);
	});

	it('gives up on a blob that never deletes after a bounded number of attempts', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setupTest();
		const stuck = await registerBlob(t);
		vi.setSystemTime(Date.now() + PENDING_UPLOAD_TTL_MS + 1);

		for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt++) {
			await runWithFailingDeletes(t, sweepExpired, {}, [stuck]);
			const rows = await pendingRows(t);
			if (attempt < MAX_DELETE_ATTEMPTS) {
				expect(rows.map((row) => row.deleteAttempts)).toEqual([attempt]);
				vi.setSystemTime((rows[0]?.expiresAt ?? 0) + 1);
			} else {
				expect(rows).toEqual([]);
			}
		}
		// The blob is left orphaned (and logged), not retried for ever.
		expect(await storedBlobs(t)).toEqual([stuck]);
	});
});

describe('transactional request-body ceiling — the documented budget is reachable', () => {
	it('accepts a normal 100 KiB binary attachment', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const bytes = Buffer.alloc(100 * 1024);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [{ filename: 'invoice.pdf', content: bytes.toString('base64') }],
		});

		expect(res.status).toBe(202);
		const [blob] = await storedBlobs(t);
		const stored = await t.run(async (ctx) => await (await ctx.storage.get(blob!))!.arrayBuffer());
		expect(Buffer.from(stored).equals(bytes)).toBe(true);
	});

	it('accepts attachments totalling exactly 10 MiB and refuses one byte more', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);
		const tenMiB = 10 * 1024 * 1024;
		const atBoundary = {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'A-1' },
			attachments: [
				{ filename: 'a.bin', content: base64Of(tenMiB - 1024) },
				{ filename: 'b.bin', content: base64Of(1024) },
			],
		};
		expect(JSON.stringify(atBoundary).length).toBeLessThanOrEqual(TRANSACTIONAL_MAX_BODY_BYTES);

		const accepted = await sendTransactional(t, atBoundary);
		expect(accepted.status).toBe(202);

		const over = await sendTransactional(t, {
			...atBoundary,
			attachments: [...atBoundary.attachments, { filename: 'c.bin', content: base64Of(1) }],
		});
		expect(over.status).toBe(400);
		expect((await over.json()).error.message).toContain('Total attachment size exceeds 10MB');
		// Only the accepted send's two blobs exist.
		expect(await storedBlobs(t)).toHaveLength(2);
	});

	it('refuses a body over the route ceiling before parsing it', async () => {
		const t = setupTest();
		await seedSendable(t);

		const res = await post(
			t,
			'/api/v1/transactional',
			'x'.repeat(TRANSACTIONAL_MAX_BODY_BYTES + 1)
		);

		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toBe('Request body too large');
	});

	it('keeps non-attachment fields to the 100,000-byte envelope', async () => {
		const t = setupTest();
		const slug = await seedSendable(t);

		const res = await sendTransactional(t, {
			slug,
			email: 'to@example.com',
			dataVariables: { orderNumber: 'x'.repeat(100_000) },
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('other than attachment content');
	});

	it('leaves every other endpoint at the 100,000-byte cap', async () => {
		const t = setupTest();
		await seedKey(t);

		const res = await post(
			t,
			'/api/v1/contacts',
			JSON.stringify({ email: 'big@example.com', firstName: 'x'.repeat(100_001) })
		);

		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toBe('Request body too large');
	});
});
