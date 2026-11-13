/**
 * The IP pool a governed send reaches the MTA with.
 *
 * End to end through the real worker action against a stubbed MTA HTTP
 * surface: the routing decision and the intake POST are read off the wire.
 * Both must name the same pool, because the MTA binds the routing lease to the
 * pool it was decided for and the intake re-checks it.
 *
 * When no `providerRoutes` row supplies a pool, the pool follows the stream:
 * campaign and automation mail go to `campaign`, transactional mail to
 * `transactional`. An operator's route pool overrides that.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import type { WorkerEnvelopeInput } from '../delivery/workerEnvelope';

const modules = import.meta.glob('../**/*.*s');

const originalFetch = global.fetch;

function requestUrl(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	return String(input);
}

function mtaFetchSpy(): ReturnType<typeof vi.fn> {
	const spy = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					decision: 'mta',
					lease: { token: 'lease-1', providerProbe: false, globalProbe: false },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true, id: 'mta-1' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		);
	global.fetch = spy as unknown as typeof fetch;
	return spy;
}

/** The pool each MTA call carried, selected by path so call order cannot fool it. */
function poolsOnTheWire(spy: ReturnType<typeof vi.fn>): { decision: unknown; send: unknown } {
	const bodyAt = (path: string): Record<string, unknown> => {
		const calls = spy.mock.calls.filter((call) => new URL(requestUrl(call[0])).pathname === path);
		expect(calls).toHaveLength(1);
		return JSON.parse((calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
	};
	return { decision: bodyAt('/send/decision')['ipPool'], send: bodyAt('/send')['ipPool'] };
}

type Harness = ReturnType<typeof convexTest>;

async function campaignEnvelope(t: Harness): Promise<WorkerEnvelopeInput> {
	const { contactId, emailSendId } = await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contact = await ctx.db.insert('contacts', createTestContact());
		return {
			contactId: contact,
			emailSendId: await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId: contact, status: 'queued' })
			),
		};
	});
	return {
		kind: 'campaign' as const,
		to: 'rcpt@example.com',
		from: 'sender@example.com',
		organizationId: 'org-test',
		template: { subject: 'hi', htmlContent: '<p>hi</p>' },
		contactInfo: { contactId, email: 'rcpt@example.com' },
		emailSendId,
		convexSiteUrl: 'https://convex.example',
	};
}

async function automationEnvelope(t: Harness): Promise<WorkerEnvelopeInput> {
	const { contactId, sendId } = await t.run(async (ctx) => ({
		contactId: await ctx.db.insert('contacts', createTestContact()),
		sendId: await ctx.db.insert('transactionalSends', {
			kind: 'automation' as const,
			email: 'rcpt@example.com',
			status: 'queued' as const,
		}),
	}));
	return {
		kind: 'transactional' as const,
		messageType: 'automation' as const,
		emailPurpose: 'marketing' as const,
		to: 'rcpt@example.com',
		from: 'sender@example.com',
		organizationId: 'org-test',
		sendId,
		template: { subject: 'drip', htmlContent: '<p>drip</p>' },
		contactId,
		listUnsubscribe: true,
		convexSiteUrl: 'https://convex.example',
	};
}

async function transactionalEnvelope(t: Harness): Promise<WorkerEnvelopeInput> {
	const sendId = await t.run(
		async (ctx) =>
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				email: 'rcpt@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
				subject: 'receipt',
			})
	);
	return {
		kind: 'transactional' as const,
		emailPurpose: 'transactional' as const,
		to: 'rcpt@example.com',
		from: 'sender@example.com',
		organizationId: 'org-test',
		sendId,
		template: { subject: 'receipt', htmlContent: '<p>receipt</p>' },
	};
}

// Load the worker's import graph once, under the hook budget, so each test
// times only its own send (see engagementScoreThreading.test.ts).
describe('ipPool threading — stream → routing decision and MTA intake', () => {
	beforeAll(async () => {
		await modules['../delivery/worker.ts']!();
	});

	beforeEach(() => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
		vi.stubEnv('INSTANCE_SECRET', 'test-routing-reentry-secret-32-bytes-minimum');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it.each([
		{ stream: 'campaign', envelope: campaignEnvelope, pool: 'campaign' },
		{ stream: 'automation', envelope: automationEnvelope, pool: 'campaign' },
		{ stream: 'transactional', envelope: transactionalEnvelope, pool: 'transactional' },
	])(
		'an unrouted $stream send (EMAIL_PROVIDER only) reaches the MTA on the $pool pool',
		async ({ envelope, pool }) => {
			const t = convexTest(schema, modules);
			const envelopeInput = await envelope(t);
			const spy = mtaFetchSpy();

			const result = await t.action(internal.delivery.worker.sendSingleEmail, { envelopeInput });

			expect(result.kind).toBe('accepted');
			expect(poolsOnTheWire(spy)).toEqual({ decision: pool, send: pool });
		}
	);

	it("an operator route's pool overrides the stream default", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				ipPool: 'transactional',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const envelopeInput = await campaignEnvelope(t);
		const spy = mtaFetchSpy();

		const result = await t.action(internal.delivery.worker.sendSingleEmail, { envelopeInput });

		expect(result.kind).toBe('accepted');
		expect(poolsOnTheWire(spy)).toEqual({ decision: 'transactional', send: 'transactional' });
	});
});
