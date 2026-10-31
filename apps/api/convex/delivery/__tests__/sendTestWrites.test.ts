/**
 * What the admin delivery test send (`delivery.statusActions.sendTest`) answers
 * and writes, branch by branch.
 *
 * Every answer is pinned whole (error copy, provider receipt, the five stages),
 * beside the two writes the action makes: the per-user rate-limit token it
 * spends before anything leaves the instance, and the readiness timestamp it
 * records once the provider accepted the message.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import type * as InstanceCounters from '../../lib/instanceCounters';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { readInstanceCounter } from '../../lib/instanceCounters';
import { modules } from '../../__tests__/testModules';
import { createTestInstanceSettings } from '../../__tests__/factories';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

const counterMocks = vi.hoisted(() => ({ isWriteRefused: false }));

// The readiness record's one failure mode worth pinning: its write throws.
vi.mock('../../lib/instanceCounters', async (importOriginal) => {
	const actual = await importOriginal<typeof InstanceCounters>();
	return {
		...actual,
		writeInstanceCounter: vi.fn(async (...args: Parameters<typeof actual.writeInstanceCounter>) => {
			if (counterMocks.isWriteRefused) throw new Error('counter write refused');
			return await actual.writeInstanceCounter(...args);
		}),
	};
});

const NOW = 1_800_000_000_000;
const MEMBER = 'admin@example.com';
const MTA_ENV = { EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' };

type Harness = ReturnType<typeof convexTest>;

// Only `Date` is faked: convex-test drives its scheduler through real timers.
// A frozen clock also freezes the token bucket, so its burst is exact.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	counterMocks.isWriteRefused = false;
});

function stubEnv(env: Record<string, string>): void {
	for (const key of ['EMAIL_PROVIDER', 'MTA_API_URL', 'MTA_API_KEY', 'DEFAULT_FROM_DOMAIN']) {
		vi.stubEnv(key, env[key]);
	}
}

/** The MTA's answer to every dispatch; returns the spy to read the calls from. */
function stubMta(response: { status: number; body: unknown }) {
	const fetchSpy = vi.fn(
		async () =>
			new Response(JSON.stringify(response.body), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' },
			})
	);
	vi.stubGlobal('fetch', fetchSpy);
	return fetchSpy;
}

async function harness(options: { defaultFromEmail?: string } = {}): Promise<Harness> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: `auth-${MEMBER}`,
			email: MEMBER,
			createdAt: NOW,
			updatedAt: NOW,
		});
		if (options.defaultFromEmail !== undefined) {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({
					defaultFromEmail: options.defaultFromEmail,
					defaultFromName: 'Owlat Ops',
				})
			);
		}
	});
	return t;
}

async function lastSucceededAt(t: Harness): Promise<number | null> {
	const counter = await t.run((ctx) => readInstanceCounter(ctx.db, 'deliveryTest'));
	return counter.deliveryTestLastSucceededAt ?? null;
}

type StageStatus = 'passed' | 'failed' | 'not_run';

/** The five stages in order, each `[status, detail]`. */
function stages(...entries: [StageStatus, string][]) {
	const keys = [
		['provider_configuration', 'Provider configuration'],
		['recipient_validation', 'Recipient address'],
		['sender_resolution', 'Sender identity'],
		['provider_acceptance', 'Provider acceptance'],
		['result_recording', 'Readiness record'],
	] as const;
	return keys.map(([key, label], index) => {
		const [status, detail] = entries[index] ?? [
			'not_run' as const,
			key === 'provider_acceptance' || key === 'result_recording' ? 'Not attempted' : 'Not checked',
		];
		return { key, label, status, detail };
	});
}

const notRun = { providerMessageId: null, latencyMs: null, attempts: null };

describe('sendTest — refusals before anything is sent', () => {
	it('no usable provider', async () => {
		stubEnv({});
		const t = await harness();
		const result = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(result).toEqual({
			success: false,
			error:
				'No delivery provider is configured. Set EMAIL_PROVIDER to a registered transport and configure its requirements, then try again.',
			provider: null,
			...notRun,
			stages: stages(['failed', 'No usable provider is configured']),
		});
		expect(await lastSucceededAt(t)).toBeNull();
	});

	it('an invalid recipient', async () => {
		stubEnv(MTA_ENV);
		const fetchSpy = stubMta({ status: 200, body: { success: true, id: 'unused' } });
		const t = await harness();
		const result = await t.action(api.delivery.statusActions.sendTest, { to: ' not-an-email ' });
		expect(result).toEqual({
			success: false,
			error: 'Enter a valid recipient address for the test email.',
			provider: 'mta',
			...notRun,
			stages: stages(['passed', 'mta is configured'], ['failed', 'Recipient address is invalid']),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('a recipient outside the member roster, after spending a rate-limit token', async () => {
		stubEnv(MTA_ENV);
		const fetchSpy = stubMta({ status: 200, body: { success: true, id: 'unused' } });
		const t = await harness();
		const refused = {
			success: false,
			error:
				"Test emails can only be sent to your organization's own member addresses. Add the recipient as a member, or use their member address.",
			provider: 'mta',
			...notRun,
			stages: stages(
				['passed', 'mta is configured'],
				['failed', 'Recipient is not an organization member address']
			),
		};
		// The bucket holds twenty: every refused attempt spends one.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const result = await t.action(api.delivery.statusActions.sendTest, {
				to: 'victim@external.example',
			});
			expect(result).toEqual(refused);
		}
		const limited = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(limited).toEqual({
			success: false,
			error: 'Too many test emails — please wait a moment and try again.',
			provider: 'mta',
			...notRun,
			stages: stages(
				['passed', 'mta is configured'],
				['failed', 'Too many test emails — wait a moment and try again']
			),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await lastSucceededAt(t)).toBeNull();
	});

	it('an invalid default sender address', async () => {
		stubEnv(MTA_ENV);
		const fetchSpy = stubMta({ status: 200, body: { success: true, id: 'unused' } });
		const t = await harness({ defaultFromEmail: 'not-a-sender' });
		const result = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(result).toEqual({
			success: false,
			error: 'The default sender address is invalid. Update the sender identity and try again.',
			provider: 'mta',
			...notRun,
			stages: stages(
				['passed', 'mta is configured'],
				['passed', 'Recipient address is valid'],
				['failed', 'Default sender address is invalid']
			),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('sendTest — the send and its record', () => {
	it('records the readiness timestamp once the provider accepts', async () => {
		stubEnv(MTA_ENV);
		const fetchSpy = stubMta({ status: 200, body: { success: true, id: 'test-message-1' } });
		const t = await harness({ defaultFromEmail: 'ops@owlat.example' });
		const result = await t.action(api.delivery.statusActions.sendTest, { to: ` ${MEMBER} ` });
		expect(result).toEqual({
			success: true,
			error: null,
			provider: 'mta',
			providerMessageId: 'test-message-1',
			latencyMs: 0,
			attempts: 1,
			stages: stages(
				['passed', 'mta is configured'],
				['passed', 'Recipient address is valid'],
				['passed', 'Sending as ops@owlat.example'],
				['passed', 'Accepted as test-message-1'],
				['passed', 'Readiness timestamp recorded']
			),
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await lastSucceededAt(t)).toBe(NOW);
	});

	it('falls back to the instance noreply sender when none is configured', async () => {
		stubEnv({ ...MTA_ENV, DEFAULT_FROM_DOMAIN: 'mail.owlat.example' });
		stubMta({ status: 200, body: { success: true, id: 'test-message-2' } });
		const t = await harness();
		const result = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(result.stages[2]).toEqual({
			key: 'sender_resolution',
			label: 'Sender identity',
			status: 'passed',
			detail: 'Sending as noreply@mail.owlat.example',
		});
		expect(result.success).toBe(true);
	});

	it('records nothing when the provider refuses the message', async () => {
		stubEnv(MTA_ENV);
		stubMta({ status: 500, body: { success: false, error: 'internal' } });
		const t = await harness({ defaultFromEmail: 'ops@owlat.example' });
		const result = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(result).toEqual({
			success: false,
			error: 'Test send failed. Check your provider credentials and the deployment logs.',
			provider: 'mta',
			...notRun,
			stages: stages(
				['passed', 'mta is configured'],
				['passed', 'Recipient address is valid'],
				['passed', 'Sending as ops@owlat.example'],
				['failed', 'mta did not accept the message']
			),
		});
		expect(await lastSucceededAt(t)).toBeNull();
	});

	it('reports an accepted message whose readiness record failed', async () => {
		stubEnv(MTA_ENV);
		stubMta({ status: 200, body: { success: true, id: 'test-message-3' } });
		const t = await harness({ defaultFromEmail: 'ops@owlat.example' });
		counterMocks.isWriteRefused = true;
		const result = await t.action(api.delivery.statusActions.sendTest, { to: MEMBER });
		expect(result).toEqual({
			success: false,
			error: 'The provider accepted the message, but the readiness result could not be recorded.',
			provider: 'mta',
			providerMessageId: 'test-message-3',
			latencyMs: 0,
			attempts: 1,
			stages: stages(
				['passed', 'mta is configured'],
				['passed', 'Recipient address is valid'],
				['passed', 'Sending as ops@owlat.example'],
				['passed', 'Accepted as test-message-3'],
				['failed', 'Could not record the readiness result']
			),
		});
		counterMocks.isWriteRefused = false;
		expect(await lastSucceededAt(t)).toBeNull();
	});
});
