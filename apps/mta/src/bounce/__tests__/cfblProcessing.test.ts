/**
 * P2-7 (c) — an inbound RFC 9477 report routes through the EXISTING FBL
 * processor and ATTRIBUTES back to the send.
 *
 * Nothing here is a second parser: the report is fed through the real
 * `extractReportParts` → `parseFblOrDsnPhase` → `tryParseARF` chain the bounce
 * SMTP server uses, with a real (mock-backed) Redis for the shipped complaint
 * dedup and the shipped delayed-feedback provenance store.
 *
 * Attribution is the point. A complaint that cannot be resolved to a send
 * cannot be resolved to a cell or an arm either (the P1-2 assignment row is
 * keyed by the same message id), so it cannot feed the complaint gate. These
 * tests lock the chain messageId → organizationId + campaignId.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseMessage } from '@owlat/mail-message';
import { parseFblOrDsnPhase } from '../phases/parseFblOrDsn.js';
import { buildCfblAddress, buildCfblToken } from '../cfblAddress.js';
import { buildVerpAddress } from '../verp.js';
import { attachFeedbackProvenance, recordFeedbackProvenance } from '../feedbackProvenance.js';
import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from '../types.js';
import type { BounceClassification } from '../../types.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';

const KEY = 'cfbl-processing-test-key';
const HOST = 'bounces.owlat.test';
const MESSAGE_ID = 'send_cfbl_0001';
// The MTA bounds a campaign id to `[a-z0-9]{16,64}` before it can become a
// metric label (see intelligence/campaignComplaintRate.ts).
const CAMPAIGN_ID = 'cmpjuly000000001';

interface ArfFixture {
	readonly feedbackFields?: string;
	readonly originalHeaders?: string;
	readonly humanText?: string;
}

/** A realistic RFC 5965 `multipart/report; report-type=feedback-report` message. */
function arfReport(fixture: ArfFixture = {}): Buffer {
	const {
		feedbackFields = 'Feedback-Type: abuse\r\nUser-Agent: Gmail-FBL/1.0\r\nVersion: 1\r\nOriginal-Rcpt-To: <victim@example.net>\r\n',
		originalHeaders = 'From: sender@acme.test\r\nTo: victim@example.net\r\nSubject: Newsletter\r\n',
		humanText = 'This is an email abuse report.',
	} = fixture;

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
			humanText,
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

/** Narrow a phase outcome to the classified attempt it short-circuited with. */
function attemptOf(outcome: PhaseOutcome): BounceAttempt {
	if (outcome.kind !== 'bounceTo') {
		throw new Error(`expected a classified attempt, got "${outcome.kind}"`);
	}
	return outcome.attempt;
}

/** Narrow further to the ARF classification of an FBL attempt. */
function arfOf(outcome: PhaseOutcome): BounceClassification {
	const attempt = attemptOf(outcome);
	if (attempt.kind !== 'fbl') throw new Error(`expected an fbl attempt, got "${attempt.kind}"`);
	return attempt.arf;
}

function jobFor(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: MESSAGE_ID,
		to: 'victim@example.net',
		from: 'sender@acme.test',
		subject: 'Newsletter',
		html: '<p>Hi</p>',
		ipPool: 'campaign',
		organizationId: 'org_acme',
		deliveryDomain: 'production',
		dkimDomain: 'acme.test',
		headers: { 'Feedback-ID': `campaign:${CAMPAIGN_ID}:topic:abc12` },
		...overrides,
	};
}

describe('P2-7 (c) — inbound CFBL report processing', () => {
	let redis: RealRedis;
	let deps: PhaseDeps;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		deps = { redis, config: { returnPathDomain: HOST } as unknown as MtaConfig };
		process.env['BOUNCE_VERP_KEY'] = KEY;
	});

	afterEach(async () => {
		await redis.flushall();
		vi.clearAllMocks();
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('attributes a report DELIVERED TO the signed CFBL address', async () => {
		const cfblAddress = buildCfblAddress(MESSAGE_ID, HOST, KEY)!;

		const arf = arfOf(await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(), cfblAddress)));

		expect(arf.originalMessageId).toBe(MESSAGE_ID);
		expect(arf.type).toBe('complained');
		// The shipped recipient/ISP extraction is untouched.
		expect(arf.recipient).toBe('victim@example.net');
		expect(arf.sourceIsp).toBe('google');
	});

	it('attributes a report echoing the signed CFBL-Feedback-ID (RFC 9477 §4.2)', async () => {
		const token = buildCfblToken(MESSAGE_ID, KEY)!;
		const raw = arfReport({
			feedbackFields: `Feedback-Type: abuse\r\nUser-Agent: Yahoo-FBL/1.0\r\nFeedback-ID: ${token}\r\nOriginal-Rcpt-To: <victim@example.net>\r\n`,
		});

		// Delivered to a generic abuse mailbox — only the echoed token attributes.
		const arf = arfOf(await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`)));

		expect(arf.originalMessageId).toBe(MESSAGE_ID);
	});

	it('resolves through to the org and campaign — the cell/arm join key', async () => {
		await recordFeedbackProvenance(redis, jobFor());
		const cfblAddress = buildCfblAddress(MESSAGE_ID, HOST, KEY)!;

		const outcome = await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(), cfblAddress));
		const enriched = await attachFeedbackProvenance(redis, attemptOf(outcome));

		expect(enriched.kind).toBe('fbl');
		if (enriched.kind !== 'fbl') return;
		expect(enriched.arf.organizationId).toBe('org_acme');
		expect(enriched.arf.campaignId).toBe(CAMPAIGN_ID);
		expect(enriched.arf.deliveryDomain).toBe('production');
		expect(enriched.arf.feedbackProvenance).toBe('production');
	});

	it('does NOT weaken the shipped VERP Original-Mail-From path', async () => {
		const verp = buildVerpAddress(MESSAGE_ID, HOST, KEY);
		// Bare addr-spec, matching what the shipped `parseVerpAddress` anchors on
		// (`^bounce\+`). An angle-bracketed value is a PRE-EXISTING gap in the VERP
		// scrape, untouched by this piece.
		const raw = arfReport({
			feedbackFields: `Feedback-Type: abuse\r\nUser-Agent: Microsoft-FBL/1.0\r\nOriginal-Mail-From: ${verp}\r\nOriginal-Rcpt-To: <victim@example.net>\r\n`,
		});

		// No CFBL handle anywhere: the pre-existing VERP attribution still works.
		const arf = arfOf(await parseFblOrDsnPhase.run(deps, ctxFor(raw, `abuse@${HOST}`)));

		expect(arf.originalMessageId).toBe(MESSAGE_ID);
		expect(arf.sourceIsp).toBe('microsoft');
	});

	it('prefers the CFBL envelope over a conflicting Original-Mail-From', async () => {
		const otherVerp = buildVerpAddress('send_other_9999', HOST, KEY);
		const raw = arfReport({
			feedbackFields: `Feedback-Type: abuse\r\nOriginal-Mail-From: <${otherVerp}>\r\nOriginal-Rcpt-To: <victim@example.net>\r\n`,
		});
		const cfblAddress = buildCfblAddress(MESSAGE_ID, HOST, KEY)!;

		// Strongest evidence wins: the report was DELIVERED to this unguessable
		// address, which no third party could have known.
		const arf = arfOf(await parseFblOrDsnPhase.run(deps, ctxFor(raw, cfblAddress)));

		expect(arf.originalMessageId).toBe(MESSAGE_ID);
	});

	it('still classifies as a complaint when nothing attributes (no CFBL, no VERP)', async () => {
		const arf = arfOf(await parseFblOrDsnPhase.run(deps, ctxFor(arfReport(), `abuse@${HOST}`)));

		expect(arf.originalMessageId).toBeUndefined();
		// Unattributed complaints stay non-destructive — the shipped posture.
		expect(arf.recipient).toBe('victim@example.net');
	});

	it('a DSN is unaffected — CFBL never hijacks the bounce path', async () => {
		const verp = buildVerpAddress(MESSAGE_ID, HOST, KEY);
		const dsn = Buffer.from(
			[
				'From: postmaster@remote.test',
				'To: <' + verp + '>',
				'Subject: Undelivered Mail',
				'MIME-Version: 1.0',
				'Content-Type: multipart/report; report-type=delivery-status; boundary="ds1"',
				'',
				'--ds1',
				'Content-Type: text/plain',
				'',
				'Delivery failed.',
				'--ds1',
				'Content-Type: message/delivery-status',
				'',
				'Final-Recipient: rfc822; victim@example.net',
				'Action: failed',
				'Status: 5.1.1',
				'--ds1--',
				'',
			].join('\r\n'),
			'utf-8'
		);

		const attempt = attemptOf(await parseFblOrDsnPhase.run(deps, ctxFor(dsn, verp)));

		expect(attempt.kind).toBe('dsn_attributed');
	});
});
