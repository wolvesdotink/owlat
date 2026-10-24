/**
 * The kill-test verdicts (scripts/kill-tests/oracle.ts), including the
 * negative controls: what a broken replay, a broken dedup or a webhook the
 * backend acknowledged without moving the Send would leave behind must fail
 * them. The Compose run itself only proves the healthy case.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plannedSends, MX_CACHE_PREFIX } from '../kill-tests/mtaScenario';
import { nxdomainReply } from '../kill-tests/world/blocklistDns';
import {
	AMBIGUOUS_ERROR_CODE,
	AMBIGUOUS_MESSAGE_PREFIX,
	backfillSubject,
	checkBackfillRun,
	checkMtaRun,
	type BackfillState,
	type SendRowState,
	type SinkTransactionState,
	type WebhookState,
} from '../kill-tests/oracle';

const plan = plannedSends();
const ambiguous = plan.find((send) => send.heldAt === 'dot')!;
const retried = plan.find((send) => send.heldAt === 'data')!;

interface MtaRun {
	smtp: SinkTransactionState[];
	webhooks: WebhookState[];
	sends: SendRowState[];
}

/** What a correct run leaves: one body, one acknowledged terminal event and one final Send each. */
function healthyMtaRun(): MtaRun {
	return {
		smtp: plan.map((send) => ({ rcpts: [send.rcpt], bodyReceived: true })),
		webhooks: plan.map((send) => ({
			event: send === ambiguous ? 'failed' : 'sent',
			messageId: send.messageId,
			backendStatus: 200,
		})),
		sends: plan.map((send) =>
			send === ambiguous
				? {
						providerMessageId: send.messageId,
						status: 'failed',
						errorCode: AMBIGUOUS_ERROR_CODE,
						errorMessage: `${AMBIGUOUS_MESSAGE_PREFIX}: SMTP outcome unknown`,
					}
				: { providerMessageId: send.messageId, status: 'delivered' }
		),
	};
}

function patchSend(run: MtaRun, messageId: string, patch: Partial<SendRowState>): void {
	run.sends = run.sends.map((row) =>
		row.providerMessageId === messageId ? { ...row, ...patch } : row
	);
}

const verdict = (run: MtaRun) => checkMtaRun(plan, run.smtp, run.webhooks, run.sends);

describe('checkMtaRun', () => {
	it('passes a run where every Send terminated once with one body', () => {
		const run = healthyMtaRun();
		// The pre-DATA kill leaves an envelope-only transaction behind: no body.
		run.smtp.push({ rcpts: [retried.rcpt], bodyReceived: false });
		// The durable outbox may deliver the same terminal event twice, and an
		// event the backend refused is retried, not counted.
		run.webhooks.push({ event: 'sent', messageId: retried.messageId, backendStatus: 200 });
		run.webhooks.push({ event: 'bounced', messageId: retried.messageId, backendStatus: 500 });
		expect(verdict(run)).toEqual([]);
	});

	it('fails a resend after the body had already reached the receiver', () => {
		const run = healthyMtaRun();
		run.smtp.push({ rcpts: [ambiguous.rcpt], bodyReceived: true });
		expect(verdict(run)).toEqual([
			`${ambiguous.messageId} (killed at dot): the receiver got 2 bodies, expected 1`,
		]);
	});

	it('fails a Send the backend still holds as queued', () => {
		// The MTA reported it, but the backend acknowledged without moving the Send.
		const run = healthyMtaRun();
		patchSend(run, retried.messageId, { status: 'queued' });
		expect(verdict(run)).toEqual([
			`${retried.messageId} (killed at data): Send is 'queued', expected delivered`,
		]);
	});

	it('fails a Send that has no row, or two rows, behind its message id', () => {
		const run = healthyMtaRun();
		run.sends = run.sends.filter((row) => row.providerMessageId !== plan[0]!.messageId);
		run.sends.push({ providerMessageId: plan[1]!.messageId, status: 'delivered' });
		expect(verdict(run)).toEqual([
			`${plan[0]!.messageId}: 0 Send rows carry its message id, expected 1`,
			`${plan[1]!.messageId}: 2 Send rows carry its message id, expected 1`,
		]);
	});

	it('fails a pre-DATA kill that was never retried', () => {
		const run = healthyMtaRun();
		run.smtp = run.smtp.filter((t) => !t.rcpts.includes(retried.rcpt));
		patchSend(run, retried.messageId, { status: 'failed' });
		expect(verdict(run)).toEqual([
			`${retried.messageId} (killed at data): the receiver got 0 bodies, expected 1`,
			`${retried.messageId} (killed at data): Send is 'failed', expected delivered`,
		]);
	});

	it('fails a post-dot kill persisted as delivered', () => {
		const run = healthyMtaRun();
		patchSend(run, ambiguous.messageId, {
			status: 'delivered',
			errorCode: undefined,
			errorMessage: undefined,
		});
		expect(verdict(run)).toEqual([
			`${ambiguous.messageId} (killed at dot): Send is 'delivered' (no code: no message), expected failed as ${AMBIGUOUS_ERROR_CODE}`,
		]);
	});

	it('fails a post-dot kill persisted as a bounce', () => {
		const run = healthyMtaRun();
		patchSend(run, ambiguous.messageId, {
			status: 'bounced',
			bounceType: 'hard',
			bouncedAt: 1,
			errorCode: undefined,
			errorMessage: undefined,
		});
		expect(verdict(run)).toEqual([
			`${ambiguous.messageId} (killed at dot): Send is 'bounced' (no code: no message), expected failed as ${AMBIGUOUS_ERROR_CODE}`,
			`${ambiguous.messageId} (killed at dot): Send carries a bounce, but an ambiguous drop is not one`,
		]);
	});

	it('fails a non-ambiguous failure for the post-dot kill', () => {
		const run = healthyMtaRun();
		patchSend(run, ambiguous.messageId, { errorCode: 'screened', errorMessage: 'Screened' });
		expect(verdict(run)).toEqual([
			`${ambiguous.messageId} (killed at dot): Send is 'failed' (screened: Screened), expected failed as ${AMBIGUOUS_ERROR_CODE}`,
		]);
	});

	it('fails contradictory terminal events the backend acknowledged', () => {
		const run = healthyMtaRun();
		run.webhooks.push({ event: 'bounced', messageId: plan[0]!.messageId, backendStatus: 200 });
		expect(verdict(run)).toEqual([
			`${plan[0]!.messageId}: contradictory terminal webhook events [sent, bounced]`,
		]);
	});
});

const UIDS = [1, 2, 3, 4, 5, 6];
const HELD = 4;

function healthyBackfill(): BackfillState {
	return {
		messages: UIDS.map((uid) => ({
			subject: backfillSubject(uid),
			rfc822MessageId: `<m-${uid}@x>`,
		})),
		ingestCalls: [
			...UIDS.map((uid) => ({
				messageId: `<m-${uid}@x>`,
				remoteUid: uid,
				outcome: 'stored' as const,
				held: uid === HELD,
			})),
			{ messageId: `<m-${HELD}@x>`, remoteUid: HELD, outcome: 'duplicate', held: false },
		],
		migration: { status: 'completed', messagesTotal: 6, messagesImported: 6, messagesFailed: 0 },
		inbox: { backfillCursor: 0, backfillTotal: 6, backfillDone: 6 },
	};
}

describe('checkBackfillRun', () => {
	it('passes a resumed import that landed every message once', () => {
		expect(checkBackfillRun(UIDS, HELD, healthyBackfill())).toEqual([]);
	});

	it('fails a re-walk that minted a new identity for a message without Message-ID', () => {
		const healthy = healthyBackfill();
		const state: BackfillState = {
			...healthy,
			messages: [
				...healthy.messages,
				{ subject: backfillSubject(HELD), rfc822MessageId: '<other@owlat-mail-sync>' },
			],
			ingestCalls: healthy.ingestCalls.map((call) =>
				call.held ? call : { ...call, outcome: 'stored' }
			),
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			`UID ${HELD}: stored 2 times (<m-${HELD}@x>, <other@owlat-mail-sync>), expected once`,
			'the mailbox holds 7 messages for a 6-message fixture',
			`UID ${HELD}: not re-ingested as a duplicate after the restart`,
		]);
	});

	it('fails a cursor that moved past messages that never landed', () => {
		const healthy = healthyBackfill();
		const state = {
			...healthy,
			messages: healthy.messages.filter((row) => row.subject !== backfillSubject(5)),
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			'UID 5: stored 0 times, expected once',
			'the mailbox holds 5 messages for a 6-message fixture',
		]);
	});

	it('fails a kill that never landed on the held ingest', () => {
		const healthy = healthyBackfill();
		const state = {
			...healthy,
			ingestCalls: healthy.ingestCalls.map((call) => ({ ...call, held: false })),
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			`UID ${HELD}: the kill never landed on its ingest`,
		]);
	});

	it('fails an import that stopped or miscounted', () => {
		const state: BackfillState = {
			...healthyBackfill(),
			inbox: { backfillCursor: 2, backfillTotal: 6, backfillDone: 4 },
			migration: {
				status: 'importing',
				messagesTotal: 6,
				messagesImported: 3,
				messagesFailed: 1,
			},
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			'backfill cursor 2, expected 0',
			'INBOX walked 4 of 6, expected 6 of 6',
			'import importing, expected completed',
			'import counted 3 imported and 1 failed of 6, expected 6 and 0 of 6',
		]);
	});

	it('fails an import the backend never recorded', () => {
		const state = { ...healthyBackfill(), migration: null, inbox: null };
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			'backfill cursor missing, expected 0',
			'INBOX walked none of none, expected 6 of 6',
			'import missing, expected completed',
			'import counted none imported and 0 failed of none, expected 6 and 0 of 6',
		]);
	});
});

describe('kill-test fixtures', () => {
	it('routes through the MX cache key the MTA resolver reads', () => {
		const resolver = readFileSync(
			new URL('../../apps/mta/src/smtp/mxResolver.ts', import.meta.url),
			'utf8'
		);
		expect(resolver).toContain(`const MX_CACHE_PREFIX = '${MX_CACHE_PREFIX}';`);
	});

	it('answers a blocklist query with NXDOMAIN for the same question', () => {
		// id 0x1234, RD, one question: 2.0.0.127.zen.spamhaus.org A IN
		const name = ['2', '0', '0', '127', 'zen', 'spamhaus', 'org'];
		const question = Buffer.concat([
			...name.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
			Buffer.from([0, 0, 1, 0, 1]),
		]);
		const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
		const reply = nxdomainReply(Buffer.concat([header, question]))!;
		expect(reply.readUInt16BE(0)).toBe(0x1234);
		expect(reply[2]! & 0x80).toBe(0x80); // a response
		expect(reply[3]! & 0x0f).toBe(3); // NXDOMAIN
		expect(reply.subarray(12)).toEqual(question);
		expect(nxdomainReply(Buffer.alloc(4))).toBeNull();
	});
});
