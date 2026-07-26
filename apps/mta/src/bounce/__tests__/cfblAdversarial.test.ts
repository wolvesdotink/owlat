/**
 * P2-7 (d) — hostile inbound reports.
 *
 * The `CFBL-Address` header is an open invitation: anyone on the internet can
 * mail the address it advertises, and a report that attributes moves a control
 * loop. So the intake must be defensive by construction —
 *
 *   - bounded sizes and no unbounded allocation,
 *   - malformed reports DROPPED and COUNTED, never thrown,
 *   - REPLAYED reports deduplicated so a captured report cannot drive a cell's
 *     complaint rate up by repetition,
 *   - a report about ANOTHER tenant's send never leaks into this tenant's
 *     attribution, and attacker-supplied org/campaign headers are never read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseMessage } from '@owlat/mail-message';
import { parseFblOrDsnPhase } from '../phases/parseFblOrDsn.js';
import { buildCfblAddress, buildCfblToken, parseCfblAddress } from '../cfblAddress.js';
import { completeComplaint, resolveCfblAttribution } from '../fblProcessor.js';
import { attachFeedbackProvenance, recordFeedbackProvenance } from '../feedbackProvenance.js';
import { cfblRejectionsTotal } from '../../monitoring/collector.js';
import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from '../types.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';

const KEY = 'cfbl-adversarial-test-key';
const HOST = 'bounces.owlat.test';
const VICTIM_MESSAGE_ID = 'send_victim_0001';
const ATTACKER_MESSAGE_ID = 'send_attacker_0001';

function arfReport(feedbackFields: string, originalHeaders = 'From: sender@acme.test\r\n'): Buffer {
	return Buffer.from(
		[
			'From: fbl@isp.example',
			'To: abuse@owlat.test',
			'Subject: Abuse report',
			'MIME-Version: 1.0',
			'Content-Type: multipart/report; report-type=feedback-report; boundary="af1"',
			'',
			'--af1',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'This is an email abuse report.',
			'--af1',
			'Content-Type: message/feedback-report',
			'',
			feedbackFields,
			'--af1',
			'Content-Type: message/rfc822',
			'',
			originalHeaders,
			'Body.',
			'--af1--',
			'',
		].join('\r\n'),
		'utf-8'
	);
}

function ctxFor(raw: Buffer, rcptTo: string | undefined): BasePhaseCtx {
	return { parsed: parseMessage(raw), rawBuffer: raw, rcptTo };
}

type PhaseOutcome = Awaited<ReturnType<typeof parseFblOrDsnPhase.run>>;

function attemptOf(outcome: PhaseOutcome): BounceAttempt {
	if (outcome.kind !== 'bounceTo') {
		throw new Error(`expected a classified attempt, got "${outcome.kind}"`);
	}
	return outcome.attempt;
}

/** Total value of the rejection counter for one reason. */
async function rejectionCount(reason: string): Promise<number> {
	const metric = await cfblRejectionsTotal.get();
	return metric.values
		.filter((value) => value.labels['reason'] === reason)
		.reduce((sum, value) => sum + value.value, 0);
}

const BASE_FIELDS = 'Feedback-Type: abuse\r\nOriginal-Rcpt-To: <victim@example.net>\r\n';

describe('P2-7 (d) — hostile CFBL reports', () => {
	let redis: RealRedis;
	let deps: PhaseDeps;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		deps = { redis, config: { returnPathDomain: HOST } as unknown as MtaConfig };
		process.env['BOUNCE_VERP_KEY'] = KEY;
		cfblRejectionsTotal.reset();
	});

	afterEach(async () => {
		await redis.flushall();
		vi.clearAllMocks();
		delete process.env['BOUNCE_VERP_KEY'];
	});

	describe('forgery is counted, not attributed and not thrown', () => {
		it('drops a forged rcpt-to token and increments the rejection counter', async () => {
			const forged = `fbl+${Buffer.from(VICTIM_MESSAGE_ID).toString('base64url')}+AAAAAAAAAAAAAA@${HOST}`;

			const attempt = attemptOf(
				await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(BASE_FIELDS), forged))
			);

			expect(attempt.kind).toBe('fbl');
			expect(attempt.kind === 'fbl' && attempt.arf.originalMessageId).toBeUndefined();
			expect(await rejectionCount('bad_signature')).toBe(1);
		});

		it('drops an UNSIGNED hand-built address', async () => {
			const unsigned = `fbl+${Buffer.from(VICTIM_MESSAGE_ID).toString('base64url')}@${HOST}`;

			const attempt = attemptOf(
				await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(BASE_FIELDS), unsigned))
			);

			expect(attempt.kind === 'fbl' && attempt.arf.originalMessageId).toBeUndefined();
			expect(await rejectionCount('unsigned')).toBe(1);
		});

		it('drops a forged CFBL-Feedback-ID echoed in the report body', async () => {
			const forgedToken = `${Buffer.from(VICTIM_MESSAGE_ID).toString('base64url')}+AAAAAAAAAAAAAA`;
			const raw = arfReport(`${BASE_FIELDS}CFBL-Feedback-ID: ${forgedToken}\r\n`);

			const attempt = attemptOf(await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`)));

			expect(attempt.kind === 'fbl' && attempt.arf.originalMessageId).toBeUndefined();
			expect(await rejectionCount('bad_signature')).toBe(1);
		});

		it('does NOT count ordinary non-CFBL traffic as a rejection', async () => {
			const raw = arfReport(`${BASE_FIELDS}Feedback-ID: campaign:cmp1:topic:abc12\r\n`);

			await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`));

			expect(await rejectionCount('not_cfbl')).toBe(0);
			expect(await rejectionCount('bad_signature')).toBe(0);
		});
	});

	describe('bounded inputs — no unbounded allocation, no throw', () => {
		it('survives an OVERSIZED report body without attributing', async () => {
			// A megabyte of junk after the fields the parser wants: the CFBL scan is
			// prefix-bounded, so this can never become a CPU/allocation amplifier.
			const raw = arfReport(`${BASE_FIELDS}X-Junk: ${'A'.repeat(1024 * 1024)}\r\n`);

			const outcome = await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`));

			expect(outcome.kind).toBe('bounceTo');
			expect(attemptOf(outcome).kind).toBe('fbl');
		});

		it('ignores a CFBL-Feedback-ID buried past the bounded scan prefix', () => {
			const token = buildCfblToken(VICTIM_MESSAGE_ID, KEY)!;
			const buried = `${'X-Pad: pad\r\n'.repeat(20_000)}CFBL-Feedback-ID: ${token}\r\n`;

			const attribution = resolveCfblAttribution({ reportText: buried }, KEY);

			expect(attribution.messageId).toBeUndefined();
			expect(attribution.rejections).toEqual([]);
		});

		it('rejects an oversized envelope recipient rather than hashing it', () => {
			const huge = `fbl+${'A'.repeat(5000)}@${HOST}`;
			expect(() => parseCfblAddress(huge, KEY)).not.toThrow();
			expect(parseCfblAddress(huge, KEY)).toEqual({ ok: false, reason: 'oversized' });
		});

		it('handles a MALFORMED ARF (truncated MIME, missing fields) without throwing', async () => {
			const truncated = Buffer.from(
				'Content-Type: multipart/report; report-type=feedback-report; boundary="af1"\r\n\r\n--af1\r\nContent-Type: message/feedback-report\r\n\r\nFeedback-Type: abuse\r\n',
				'utf-8'
			);
			const cfblAddress = buildCfblAddress(VICTIM_MESSAGE_ID, HOST, KEY)!;

			const outcome = await parseFblOrDsnPhase.run(deps, ctxFor(truncated, cfblAddress));

			// The signed envelope still attributes even though the body is garbage —
			// and nothing threw.
			const attempt = attemptOf(outcome);
			expect(attempt.kind === 'fbl' && attempt.arf.originalMessageId).toBe(VICTIM_MESSAGE_ID);
			expect(attempt.kind === 'fbl' && attempt.arf.recipient).toBeUndefined();
		});

		it('handles an EMPTY report body', async () => {
			const empty = Buffer.from(
				'Content-Type: multipart/report; report-type=feedback-report\r\n\r\n',
				'utf-8'
			);
			const cfblAddress = buildCfblAddress(VICTIM_MESSAGE_ID, HOST, KEY)!;

			await expect(parseFblOrDsnPhase.run(deps, ctxFor(empty, cfblAddress))).resolves.toBeDefined();
		});
	});

	describe('replay — a captured report cannot be counted twice', () => {
		it('deduplicates a byte-identical replay of a signed CFBL report', async () => {
			const cfblAddress = buildCfblAddress(VICTIM_MESSAGE_ID, HOST, KEY)!;
			const raw = arfReport(BASE_FIELDS);

			const first = await parseFblOrDsnPhase.run(deps, ctxFor(raw, cfblAddress));
			expect(first.kind).toBe('bounceTo');
			const attempt = attemptOf(first);
			expect(attempt.kind).toBe('fbl');
			// The shipped reservation is only durable once the effect completes.
			if (attempt.kind === 'fbl') {
				await completeComplaint(redis, attempt.dedupReservation);
			}

			const replay = await parseFblOrDsnPhase.run(deps, ctxFor(raw, cfblAddress));

			expect(replay).toEqual({ kind: 'dropSilently', reason: 'duplicate_fbl_complaint' });
		});

		it('deduplicates a replay whose BODY was mutated — the key is the signed send', async () => {
			const cfblAddress = buildCfblAddress(VICTIM_MESSAGE_ID, HOST, KEY)!;

			const first = attemptOf(
				await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(BASE_FIELDS), cfblAddress))
			);
			if (first.kind === 'fbl') await completeComplaint(redis, first.dedupReservation);

			// Same signed address, different human text / ISP branding.
			const mutated = arfReport(`${BASE_FIELDS}User-Agent: Yahoo-FBL/9.9\r\n`);
			const replay = await parseFblOrDsnPhase.run(deps, ctxFor(mutated, cfblAddress));

			expect(replay).toEqual({ kind: 'dropSilently', reason: 'duplicate_fbl_complaint' });
		});
	});

	describe('tenant isolation', () => {
		function jobFor(messageId: string, organizationId: string): EmailJob {
			return {
				messageId,
				to: 'victim@example.net',
				from: 'sender@acme.test',
				subject: 'Newsletter',
				html: '<p>Hi</p>',
				ipPool: 'campaign',
				organizationId,
				deliveryDomain: 'production',
				dkimDomain: 'acme.test',
			};
		}

		it('a token for ANOTHER org’s send never attributes to the attacker’s org', async () => {
			await recordFeedbackProvenance(redis, jobFor(VICTIM_MESSAGE_ID, 'org_victim'));
			await recordFeedbackProvenance(redis, jobFor(ATTACKER_MESSAGE_ID, 'org_attacker'));

			// The attacker holds a legitimately-signed token for their OWN send and
			// dresses the report up as the victim's.
			const attackerAddress = buildCfblAddress(ATTACKER_MESSAGE_ID, HOST, KEY)!;
			const raw = arfReport(
				BASE_FIELDS,
				`From: sender@acme.test\r\nX-Owlat-Org-Id: org_victim\r\nX-Owlat-Message-Id: ${VICTIM_MESSAGE_ID}\r\n`
			);

			const outcome = await parseFblOrDsnPhase.run(deps, ctxFor(raw, attackerAddress));
			const enriched = await attachFeedbackProvenance(redis, attemptOf(outcome));

			expect(enriched.kind).toBe('fbl');
			if (enriched.kind !== 'fbl') return;
			// Attribution follows the SIGNATURE and the server-persisted record —
			// never the attacker-supplied headers in the re-attached message.
			expect(enriched.arf.originalMessageId).toBe(ATTACKER_MESSAGE_ID);
			expect(enriched.arf.organizationId).toBe('org_attacker');
		});

		it('an unsigned X-Owlat-Org-Id / X-Owlat-Message-Id scrape is never trusted', async () => {
			await recordFeedbackProvenance(redis, jobFor(VICTIM_MESSAGE_ID, 'org_victim'));
			const raw = arfReport(
				BASE_FIELDS,
				`From: sender@acme.test\r\nX-Owlat-Org-Id: org_victim\r\nX-Owlat-Message-Id: ${VICTIM_MESSAGE_ID}\r\n`
			);

			const outcome = await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`));
			const enriched = await attachFeedbackProvenance(redis, attemptOf(outcome));

			if (enriched.kind !== 'fbl') throw new Error('expected an fbl attempt');
			expect(enriched.arf.originalMessageId).toBeUndefined();
			expect(enriched.arf.organizationId).toBeUndefined();
			expect(enriched.arf.feedbackProvenance).toBe('unknown');
		});
	});

	describe('clock skew and degenerate inputs', () => {
		it('a token minted one window in the FUTURE still verifies', () => {
			const now = Date.UTC(2026, 6, 27, 12, 0, 0);
			const future = buildCfblAddress(VICTIM_MESSAGE_ID, HOST, KEY, now + 24 * 60 * 60 * 1000)!;
			expect(parseCfblAddress(future, KEY, now)).toEqual({
				ok: true,
				messageId: VICTIM_MESSAGE_ID,
			});
		});

		it('an empty / whitespace envelope recipient is simply not a CFBL handle', () => {
			expect(resolveCfblAttribution({ rcptTo: '', reportText: '' }, KEY).messageId).toBeUndefined();
			expect(resolveCfblAttribution({ rcptTo: '   ', reportText: '' }, KEY).rejections).toEqual([]);
		});

		it('a base64url payload that decodes to control bytes is malformed, not attributed', () => {
			const encoded = Buffer.from('').toString('base64url');
			// Sign it properly so only the PAYLOAD check can reject it.
			const address = `fbl+${encoded}+${buildCfblToken('', KEY)?.split('+')[1] ?? ''}@${HOST}`;
			expect(parseCfblAddress(address, KEY)).toEqual({ ok: false, reason: 'malformed_payload' });
		});
	});
});
