import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { hmacSha256Hex } from '../../webhooks/security';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from '../payload';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn(async () => 'test-org') };
});

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../slack/'),
			mod,
		])
	),
};

const PATH = '/webhooks/slack/approvals';
const SECRET = 'slack-signing-secret';

// The endpoint rate-limits before signature verification, so the rate-limiter
// component must be registered in the harness.
function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

function callbackBody(token: string, decision: 'approve' | 'reject', userId = 'U1'): string {
	const params = new URLSearchParams();
	params.set(
		'payload',
		JSON.stringify({
			type: 'block_actions',
			user: { id: userId },
			actions: [
				{
					action_id: decision === 'approve' ? APPROVE_ACTION_ID : REJECT_ACTION_ID,
					value: token,
				},
			],
		})
	);
	return params.toString();
}

async function signedRequest(
	body: string,
	opts: { timestamp?: number; signature?: string } = {}
): Promise<RequestInit> {
	const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
	const signature =
		opts.signature ?? `v0=${await hmacSha256Hex(SECRET, `v0:${timestamp}:${body}`)}`;
	return {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Slack-Request-Timestamp': String(timestamp),
			'X-Slack-Signature': signature,
		},
		body,
	};
}

async function seedHold(t: TestConvex<typeof schema>, quorum = 1): Promise<string> {
	const inboundMessageId: Id<'inboundMessages'> = await t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `mid-${Math.random()}`,
			from: 'alice@customer.example',
			to: 'support@example.test',
			subject: 'Order question',
			processingStatus: 'drafting',
			receivedAt: Date.now(),
		})
	);
	await t.mutation(internal.slack.approvals.ensureHold, {
		inboundMessageId,
		quorum,
		ttlMs: 60_000,
	});
	const row = await t.run(async (ctx) =>
		ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_org_and_message', (q) =>
				q.eq('organizationId', 'test-org').eq('inboundMessageId', inboundMessageId)
			)
			.unique()
	);
	if (!row) throw new Error('no hold');
	return row.approvalToken;
}

async function statusOf(t: TestConvex<typeof schema>, token: string): Promise<string> {
	const row = await t.run(async (ctx) =>
		ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_token', (q) => q.eq('approvalToken', token))
			.unique()
	);
	return `${row?.votes.length ?? -1}`;
}

describe('Slack callback endpoint — records a signed vote', () => {
	it('records an approve vote from a valid signed request', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const token = await seedHold(t, 2);

		const body = callbackBody(token, 'approve', 'U1');
		const res = await t.fetch(PATH, await signedRequest(body));
		expect(res.status).toBe(200);
		expect(await statusOf(t, token)).toBe('1');
	});
});

describe('Slack callback endpoint — fails closed on auth', () => {
	it('returns 503 when the signing secret is unset (no vote)', async () => {
		const t = makeT();
		const token = await seedHold(t);
		const body = callbackBody(token, 'approve');
		const res = await t.fetch(PATH, await signedRequest(body));
		expect(res.status).toBe(503);
		expect(await statusOf(t, token)).toBe('0');
	});

	it('rejects a bad signature with 401 and records no vote', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const token = await seedHold(t);
		const body = callbackBody(token, 'approve');
		const res = await t.fetch(PATH, await signedRequest(body, { signature: 'v0=deadbeef' }));
		expect(res.status).toBe(401);
		expect(await statusOf(t, token)).toBe('0');
	});

	it('rejects a replayed (stale) timestamp with 401 and records no vote', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const token = await seedHold(t);
		const body = callbackBody(token, 'approve');
		const stale = Math.floor(Date.now() / 1000) - 60 * 10;
		const res = await t.fetch(PATH, await signedRequest(body, { timestamp: stale }));
		expect(res.status).toBe(401);
		expect(await statusOf(t, token)).toBe('0');
	});
});

describe('Slack callback endpoint — input + method handling', () => {
	it('does not accept a GET (POST-only route)', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const res = await t.fetch(PATH, { method: 'GET' });
		// The route is registered POST-only, so the router rejects a GET before
		// the handler; either way a GET can never record a vote.
		expect(res.status).toBe(404);
	});

	it('rejects a signed-but-malformed payload with 400', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const body = 'payload=not-json';
		const res = await t.fetch(PATH, await signedRequest(body));
		expect(res.status).toBe(400);
	});
});

describe('Slack callback endpoint — dedup + reject reach the record only', () => {
	it('a duplicate signed vote is idempotent (no quorum inflation)', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const token = await seedHold(t, 2);
		const body = callbackBody(token, 'approve', 'U1');
		await t.fetch(PATH, await signedRequest(body));
		const res = await t.fetch(PATH, await signedRequest(body));
		expect(res.status).toBe(200);
		expect(await statusOf(t, token)).toBe('1');
	});

	it('an approved quorum via the endpoint never marks the message sent', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', SECRET);
		const t = makeT();
		const inboundMessageId: Id<'inboundMessages'> = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: `mid-${Math.random()}`,
				from: 'alice@customer.example',
				to: 'support@example.test',
				subject: 'Order question',
				processingStatus: 'drafting',
				receivedAt: Date.now(),
			})
		);
		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 1,
			ttlMs: 60_000,
		});
		const token = (await t.run(async (ctx) =>
			ctx.db
				.query('slackApprovalRequests')
				.withIndex('by_org_and_message', (q) =>
					q.eq('organizationId', 'test-org').eq('inboundMessageId', inboundMessageId)
				)
				.unique()
		))!.approvalToken;

		const res = await t.fetch(PATH, await signedRequest(callbackBody(token, 'approve')));
		expect(res.status).toBe(200);

		// The hold is 'approved' — but the message processing status is UNCHANGED.
		// Slack approval releases only the hold gate; it never sends or approves.
		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status.status).toBe('approved');
		const message = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
		expect(message?.processingStatus).toBe('drafting');
	});
});
