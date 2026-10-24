/**
 * The kill-test verdicts (scripts/kill-tests/oracle.ts), including the
 * negative controls: what a broken replay or a broken dedup would leave behind
 * must fail them. The Compose run itself only proves the healthy case.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plannedSends, MX_CACHE_PREFIX } from '../kill-tests/mtaScenario';
import { nxdomainReply } from '../kill-tests/world/blocklistDns';
import {
	AMBIGUOUS_MESSAGE_PREFIX,
	checkBackfillRun,
	checkMtaRun,
	type BackfillState,
	type SinkTransactionState,
	type WebhookState,
} from '../kill-tests/oracle';

const plan = plannedSends();
const ambiguous = plan.find((send) => send.heldAt === 'dot')!;
const retried = plan.find((send) => send.heldAt === 'data')!;

/** What a correct run records: one body and one terminal event per send. */
function healthyMtaRun(): { smtp: SinkTransactionState[]; webhooks: WebhookState[] } {
	return {
		smtp: plan.map((send) => ({ rcpts: [send.rcpt], bodyReceived: true })),
		webhooks: plan.map((send) =>
			send === ambiguous
				? {
						event: 'failed',
						messageId: send.messageId,
						body: { message: `${AMBIGUOUS_MESSAGE_PREFIX}: SMTP outcome unknown` },
					}
				: { event: 'sent', messageId: send.messageId, body: {} }
		),
	};
}

describe('checkMtaRun', () => {
	it('passes a run where every send terminated once with one body', () => {
		const run = healthyMtaRun();
		// The pre-DATA kill leaves an envelope-only transaction behind: no body.
		run.smtp.push({ rcpts: [retried.rcpt], bodyReceived: false });
		// The durable outbox may deliver the same terminal event twice.
		run.webhooks.push({ event: 'sent', messageId: retried.messageId, body: {} });
		expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([]);
	});

	it('fails a resend after the body had already reached the receiver', () => {
		const run = healthyMtaRun();
		run.smtp.push({ rcpts: [ambiguous.rcpt], bodyReceived: true });
		expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([
			`${ambiguous.messageId} (killed at dot): the receiver got 2 bodies, expected 1`,
		]);
	});

	it('fails a send the restart never terminated', () => {
		const run = healthyMtaRun();
		run.webhooks = run.webhooks.filter((w) => w.messageId !== retried.messageId);
		expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([
			`${retried.messageId} (killed at data): terminal webhook events [], expected exactly one kind`,
		]);
	});

	it('fails a pre-DATA kill that was never retried', () => {
		const run = healthyMtaRun();
		run.smtp = run.smtp.filter((t) => !t.rcpts.includes(retried.rcpt));
		run.webhooks = run.webhooks.map((w) =>
			w.messageId === retried.messageId ? { ...w, event: 'failed' } : w
		);
		expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([
			`${retried.messageId} (killed at data): the receiver got 0 bodies, expected 1`,
			`${retried.messageId} (killed at data): expected 'sent', got 'failed'`,
		]);
	});

	it('fails a post-dot kill reported as delivered or as a bounce', () => {
		for (const event of ['sent', 'bounced']) {
			const run = healthyMtaRun();
			run.webhooks = run.webhooks.map((w) =>
				w.messageId === ambiguous.messageId ? { ...w, event, body: {} } : w
			);
			expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([
				`${ambiguous.messageId} (killed at dot): expected an ambiguous 'failed' event, got '${event}' (no message)`,
			]);
		}
	});

	it('fails contradictory terminal events for one send', () => {
		const run = healthyMtaRun();
		run.webhooks.push({ event: 'bounced', messageId: plan[0]!.messageId, body: {} });
		expect(checkMtaRun(plan, run.smtp, run.webhooks)).toEqual([
			`${plan[0]!.messageId}: terminal webhook events [sent, bounced], expected exactly one kind`,
		]);
	});
});

const UIDS = [1, 2, 3, 4, 5, 6];
const HELD = 4;

function healthyBackfill(): BackfillState {
	return {
		migrationStatus: 'finalizing',
		inboxCursor: 0,
		stored: UIDS.map((uid) => ({ messageId: `<m-${uid}@x>`, remoteUid: uid })),
		ingestCalls: [
			...UIDS.map((uid) => ({
				messageId: `<m-${uid}@x>`,
				remoteUid: uid,
				outcome: 'stored' as const,
				held: uid === HELD,
			})),
			{ messageId: `<m-${HELD}@x>`, remoteUid: HELD, outcome: 'duplicate', held: false },
		],
		progress: [
			{ imported: 4, failed: 0 },
			{ imported: 2, failed: 0 },
		],
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
			stored: [...healthy.stored, { messageId: '<other@owlat-mail-sync>', remoteUid: HELD }],
			ingestCalls: healthy.ingestCalls.map((call) =>
				call.held ? call : { ...call, outcome: 'stored' }
			),
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			`UID ${HELD}: stored 2 times (<m-${HELD}@x>, <other@owlat-mail-sync>), expected once`,
			`stored 7 messages for a 6-message fixture`,
			`UID ${HELD}: not re-ingested as a duplicate after the restart`,
		]);
	});

	it('fails a cursor that moved past messages that never landed', () => {
		const healthy = healthyBackfill();
		const state = { ...healthy, stored: healthy.stored.filter((row) => row.remoteUid !== 5) };
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			'UID 5: stored 0 times, expected once',
			'stored 5 messages for a 6-message fixture',
		]);
	});

	it('fails an import that stopped or miscounted', () => {
		const state = {
			...healthyBackfill(),
			inboxCursor: 2,
			migrationStatus: 'importing',
			progress: [{ imported: 3, failed: 1 }],
		};
		expect(checkBackfillRun(UIDS, HELD, state)).toEqual([
			'backfill cursor 2, expected 0',
			'migration importing, expected the import handed to finalize',
			'progress counted 3 imported and 1 failed, expected 6 and 0',
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
