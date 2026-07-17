import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

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

const SLACK_URL = 'https://hooks.slack.com/services/T/B/xxx';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function seedToken(t: TestConvex<typeof schema>, webhookUrl: string): Promise<string> {
	vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', 'secret');
	vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', webhookUrl);
	const inboundMessageId: Id<'inboundMessages'> = await t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `mid-${Math.random()}`,
			from: 'a@b.example',
			to: 'support@example.test',
			subject: 's',
			processingStatus: 'drafting',
			receivedAt: Date.now(),
		})
	);
	await t.mutation(internal.slack.approvals.ensureHold, {
		inboundMessageId,
		quorum: 1,
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
	return row!.approvalToken;
}

async function notifyStatusOf(t: TestConvex<typeof schema>, token: string) {
	const row = await t.run(async (ctx) =>
		ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_token', (q) => q.eq('approvalToken', token))
			.unique()
	);
	return { status: row?.notifyStatus, attempts: row?.notifyAttempts };
}

describe('postApprovalRequest — outbound automation notification', () => {
	it('posts to Slack and records sent on success', async () => {
		const t = convexTest(schema, modules);
		const token = await seedToken(t, SLACK_URL);
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		await t.action(internal.slack.notify.postApprovalRequest, { approvalToken: token });

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(SLACK_URL, expect.anything());
		expect(await notifyStatusOf(t, token)).toEqual({ status: 'sent', attempts: 1 });
	});

	it('records failed on a non-2xx Slack response (hold stands)', async () => {
		const t = convexTest(schema, modules);
		const token = await seedToken(t, SLACK_URL);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 500 }))
		);

		await t.action(internal.slack.notify.postApprovalRequest, { approvalToken: token });
		expect((await notifyStatusOf(t, token)).status).toBe('failed');
	});

	it('records failed on a network error without crashing', async () => {
		const t = convexTest(schema, modules);
		const token = await seedToken(t, SLACK_URL);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);

		await t.action(internal.slack.notify.postApprovalRequest, { approvalToken: token });
		expect((await notifyStatusOf(t, token)).status).toBe('failed');
	});

	it('refuses a non-Slack webhook URL (SSRF) and never fetches', async () => {
		const t = convexTest(schema, modules);
		const token = await seedToken(t, 'https://evil.example.com/hook');
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await t.action(internal.slack.notify.postApprovalRequest, { approvalToken: token });
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await notifyStatusOf(t, token)).status).toBe('failed');
	});
});
