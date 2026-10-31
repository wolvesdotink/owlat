/**
 * What `applyCompletion` writes, arm by arm.
 *
 * One row per worker answer: the Send's terminal fields, the deferral stamp,
 * the follow-up jobs the completion schedules (by name and delay) and the
 * failure it throws. The handler's deciding lives in `../sendCompletionDecision`;
 * this table is what proves the plan it returns is the one the handler runs.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { seedAssignedSend } from '../../analytics/__tests__/transportOutcomesFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_completion') };
});

const NOW = 1_800_000_000_000;
const EXPIRED = NOW - GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 1;
const testWorkId = 'test-work-id' as WorkId;

// Only `Date` is faked: convex-test drives its scheduler through real timers.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

type Harness = ReturnType<typeof convexTest>;

function envelope(sendId: Id<'emailSends'>) {
	return {
		kind: 'campaign' as const,
		to: 'recipient@example.com',
		from: 'sender@example.com',
		template: { subject: 'Subject', htmlContent: '<p>Body</p>' },
		contactInfo: { email: 'recipient@example.com' },
		emailSendId: sendId,
	};
}

function retryState(sendId: Id<'emailSends'>, startedAt: number, attempt = 1) {
	return { attempt, startedAt, idempotencyKey: `send_${sendId}` };
}

interface Seed {
	status?: 'queued' | 'sent';
	providerMessageId?: string;
}

interface Observed {
	// `null` for an absent field: `t.run` drops undefined keys on the way out.
	status: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	providerMessageId: string | null;
	providerType: string | null;
	isDeferralCounted: boolean;
	/** Completion follow-ups, `<name>@<delay from NOW>`. */
	jobs: string[];
	thrown: string | null;
}

/** Run one completion against a freshly seeded Send and read back its writes. */
async function complete(
	seed: Seed,
	result: (sendId: Id<'emailSends'>) => unknown,
	options: { isEnvelopeStripped?: boolean } = {}
): Promise<Observed> {
	const t: Harness = convexTest(schema, modules);
	const { sendId } = await t.run(
		async (ctx) =>
			await seedAssignedSend(ctx, {
				status: seed.status ?? 'queued',
				...(seed.providerMessageId !== undefined
					? { providerMessageId: seed.providerMessageId }
					: {}),
			})
	);
	if (seed.providerMessageId === undefined) {
		await t.run((ctx) => ctx.db.patch(sendId, { providerMessageId: undefined }));
	}
	let thrown: string | null = null;
	try {
		await t.mutation(internal.delivery.sendCompletion.applyCompletion, {
			workId: testWorkId,
			result: result(sendId) as never,
			context: { sendRef: { kind: 'campaign', id: sendId } },
			...(options.isEnvelopeStripped !== undefined
				? { isEnvelopeStripped: options.isEnvelopeStripped }
				: {}),
		});
	} catch (error) {
		thrown = error instanceof Error ? error.message : String(error);
	}
	return await t.run(async (ctx): Promise<Observed> => {
		const send = await ctx.db.get(sendId);
		const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
		return {
			status: send?.status ?? null,
			errorCode: send?.errorCode ?? null,
			errorMessage: send?.errorMessage ?? null,
			providerMessageId: send?.providerMessageId ?? null,
			providerType: send?.providerType ?? null,
			isDeferralCounted: send?.deferralCountedDay !== undefined,
			jobs: scheduled
				.filter((job) => /retrySend|expireUnconfirmedAcceptance/.test(job.name))
				.map((job) => `${job.name.split(':').pop()}@${job.scheduledTime - NOW}`),
			thrown,
		};
	});
}

const success = (returnValue: unknown) => () => ({ kind: 'success' as const, returnValue });

const queuedUntouched = {
	status: 'queued',
	errorCode: null,
	errorMessage: null,
	isDeferralCounted: false,
	jobs: [],
	thrown: null,
};

describe('applyCompletion — runs that produced no outcome', () => {
	it('a failed run terminalizes with its error under WORKPOOL_FAILED', async () => {
		const observed = await complete({}, () => ({ kind: 'failed', error: 'worker threw' }));
		expect(observed).toMatchObject({
			status: 'failed',
			errorCode: 'WORKPOOL_FAILED',
			errorMessage: 'worker threw',
			jobs: [],
			thrown: null,
		});
	});

	it('a failed run with an empty error and a cancelled run both read as Unknown error', async () => {
		for (const result of [{ kind: 'failed', error: '' }, { kind: 'canceled' }]) {
			const observed = await complete({}, () => result);
			expect(observed).toMatchObject({
				status: 'failed',
				errorCode: 'WORKPOOL_FAILED',
				errorMessage: 'Unknown error',
			});
		}
	});

	it('an unreadable worker answer terminalizes under its own code', async () => {
		const observed = await complete({}, success({ kind: 'delivered', to: 'x@example.com' }));
		expect(observed).toMatchObject({
			status: 'failed',
			errorCode: 'WORKER_RESULT_MALFORMED',
			errorMessage:
				'The send worker answered with a result this deployment cannot read; the message may or may not have been delivered',
			jobs: [],
		});
	});
});

describe('applyCompletion — awaitingFeedback parks the Send', () => {
	const parked = (startedAt: number, stateStartedAt: number) => (sendId: Id<'emailSends'>) => ({
		kind: 'success' as const,
		returnValue: {
			kind: 'awaitingFeedback',
			providerType: 'mandrill',
			startedAt,
			retryState: retryState(sendId, stateStartedAt),
		},
	});

	it('arms the deadline from the retry state start, not the arm copy', async () => {
		const observed = await complete({}, parked(NOW - 5_000, NOW - 9_000));
		expect(observed).toMatchObject({
			...queuedUntouched,
			jobs: [`expireUnconfirmedAcceptance@${GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 9_000}`],
		});
	});

	it('clamps a future start to now, so the wait is one deadline at most', async () => {
		const observed = await complete({}, parked(NOW + 60_000, NOW + 60_000));
		expect(observed.jobs).toEqual([
			`expireUnconfirmedAcceptance@${GOVERNED_MTA_MAX_MESSAGE_AGE_MS}`,
		]);
	});

	it('closes the park on the spot once the deadline has passed', async () => {
		const observed = await complete({}, parked(EXPIRED, EXPIRED));
		expect(observed).toMatchObject({
			status: 'failed',
			errorCode: 'PROVIDER_ACCEPTANCE_UNCONFIRMED',
			jobs: [],
		});
	});

	it('leaves a Send that is no longer queued alone', async () => {
		const observed = await complete(
			{ status: 'sent', providerMessageId: 'msg-1' },
			parked(NOW, NOW)
		);
		expect(observed).toMatchObject({ status: 'sent', errorCode: null, jobs: [] });
	});
});

describe('applyCompletion — acceptanceUnknown replays the attempt', () => {
	const unknown = (startedAt: number, retryAfterMs?: number) => (sendId: Id<'emailSends'>) => ({
		kind: 'success' as const,
		returnValue: {
			kind: 'acceptanceUnknown',
			providerMessageId: 'mta-unknown-1',
			workAttemptId: 'attempt-1',
			startedAt,
			envelopeInput: envelope(sendId),
			retryState: retryState(sendId, startedAt),
			...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		},
	});

	it('schedules the replay inside the deadline', async () => {
		const observed = await complete({}, unknown(NOW, 120_000));
		expect(observed).toMatchObject({ ...queuedUntouched, jobs: ['retrySend@120000'] });
	});

	it('refuses a replay whose envelope was not stored', async () => {
		const observed = await complete({}, unknown(NOW, 120_000), { isEnvelopeStripped: true });
		expect(observed.thrown).toMatch(/delivery\.envelope_not_stored/);
		expect(observed).toMatchObject({ status: 'queued', jobs: [] });
	});

	it('closes the intake question past the deadline, by provider message id', async () => {
		const observed = await complete({ providerMessageId: 'mta-unknown-1' }, unknown(EXPIRED));
		expect(observed).toMatchObject({
			status: 'failed',
			errorCode: 'MTA_ACCEPTANCE_UNCONFIRMED',
			errorMessage: 'MTA intake acceptance could not be confirmed before the delivery deadline',
			jobs: [],
		});
	});

	it('leaves a Send that is no longer queued alone', async () => {
		const observed = await complete({ status: 'sent', providerMessageId: 'msg-1' }, unknown(NOW));
		expect(observed).toMatchObject({ status: 'sent', jobs: [], thrown: null });
	});
});

describe('applyCompletion — deferred', () => {
	const deferred =
		(origin: 'governed' | 'local', options: { attempt?: number; startedAt?: number } = {}) =>
		(sendId: Id<'emailSends'>) => ({
			kind: 'success' as const,
			returnValue: {
				kind: 'deferred',
				deferralOrigin: origin,
				retryAfterMs: 60_000,
				envelopeInput: envelope(sendId),
				retryState: retryState(sendId, options.startedAt ?? NOW, options.attempt ?? 2),
			},
		});

	it('counts a governed deferral and schedules the re-entry', async () => {
		const observed = await complete({}, deferred('governed'));
		expect(observed).toMatchObject({
			...queuedUntouched,
			isDeferralCounted: true,
			jobs: ['retrySend@60000'],
		});
	});

	it('does not count a local deferral', async () => {
		const observed = await complete({}, deferred('local'));
		expect(observed).toMatchObject({ ...queuedUntouched, jobs: ['retrySend@60000'] });
	});

	it('terminalizes once the attempts run out, after counting the deferral', async () => {
		const observed = await complete({}, deferred('governed', { attempt: 9 }));
		expect(observed).toMatchObject({
			status: 'failed',
			errorCode: 'WORKPOOL_FAILED',
			errorMessage: 'Unknown error',
			isDeferralCounted: true,
			jobs: [],
		});
	});

	it('terminalizes past the delivery deadline', async () => {
		const observed = await complete({}, deferred('local', { startedAt: EXPIRED }));
		expect(observed).toMatchObject({ status: 'failed', errorCode: 'WORKPOOL_FAILED', jobs: [] });
	});

	it('refuses a re-entry whose envelope was not stored, rolling back the count', async () => {
		const observed = await complete({}, deferred('governed'), { isEnvelopeStripped: true });
		expect(observed.thrown).toMatch(/delivery\.envelope_not_stored/);
		expect(observed).toMatchObject({ status: 'queued', isDeferralCounted: false, jobs: [] });
	});
});

describe('applyCompletion — accepted', () => {
	const accepted = (isCustodyHandoff: boolean) =>
		success({
			kind: 'accepted',
			providerMessageId: 'msg-accepted',
			providerType: 'ses',
			sendLatencyMs: 10,
			isCustodyHandoff,
		});

	it('a direct acceptance transitions the Send to sent', async () => {
		const observed = await complete({}, accepted(false));
		expect(observed).toMatchObject({
			status: 'sent',
			providerMessageId: 'msg-accepted',
			providerType: 'ses',
			jobs: [],
		});
	});

	it('a custody handoff records the provider identity and keeps the Send queued', async () => {
		const observed = await complete({}, accepted(true));
		expect(observed).toMatchObject({
			...queuedUntouched,
			providerMessageId: 'msg-accepted',
			providerType: 'ses',
		});
	});

	it('a custody handoff that names a different message id is refused', async () => {
		const observed = await complete({ providerMessageId: 'msg-other' }, accepted(true));
		expect(observed.thrown).toMatch(/delivery\.send_identity_conflict/);
		expect(observed).toMatchObject({ status: 'queued', providerMessageId: 'msg-other' });
	});

	it('a custody handoff for a Send that already settled writes nothing', async () => {
		const observed = await complete(
			{ status: 'sent', providerMessageId: 'msg-other' },
			accepted(true)
		);
		expect(observed).toMatchObject({
			status: 'sent',
			providerMessageId: 'msg-other',
			providerType: 'mta',
			thrown: null,
		});
	});
});

describe('applyCompletion — suppressed', () => {
	it.each([
		[undefined, 'RECIPIENT_SUPPRESSED', 'Recipient suppressed (blocklist) before dispatch'],
		[
			'contact_unsubscribed',
			'RECIPIENT_UNSUBSCRIBED',
			'Contact unsubscribed from marketing before dispatch',
		],
		['contact_deleted', 'CONTACT_DELETED', 'Contact deleted before dispatch'],
	])('reason %s terminalizes as %s', async (reason, errorCode, errorMessage) => {
		const observed = await complete(
			{},
			success({ kind: 'suppressed', ...(reason !== undefined ? { reason } : {}) })
		);
		expect(observed).toMatchObject({ status: 'failed', errorCode, errorMessage, jobs: [] });
	});
});
