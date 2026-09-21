/**
 * OSTR on the inbound path, end to end through `buildOnConnect` + `buildOnData`
 * (plan §12.2, §7.2).
 *
 * Four properties, in descending order of how badly they would hurt to break:
 *
 *   1. OFF IS INERT. At the default flags the ctx `onData` builds — and so the
 *      `mailboxPayload` Convex receives — is exactly the pre-OSTR one: same
 *      keys, same order, no `ostr*` present-but-undefined. Asserted against an
 *      explicit key list, so a stray field cannot be blessed by re-recording.
 *   2. A SIGNAL, NOT A GATE. A tier rides the payload and the handler still
 *      ACKs: acceptance was decided before the lookup ran, so a registry that
 *      times out, errors or answers `flagged` changes nothing about the reply.
 *   3. ONE IDENTITY, ONE LOOKUP. The IP half is asked once per CONNECTION, and
 *      the domain asked about is the one the message is judged on — not
 *      whichever signer happened to sign last.
 *   4. EVIDENCE ONLY WHEN ASKED FOR, AND ONLY IF IT IS EVIDENCE. The tap is
 *      handed to `verifyDkim` only in observer mode, and the blob is attached
 *      only for an admissible passing signature.
 *
 * `verifyDkim` is mocked here (its own suites cover verification); what is under
 * test is the wiring around it — whether the tap is passed, and what `onData`
 * does with what comes back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@owlat/mail-auth', () => ({
	checkSpf: vi.fn(),
	dnsDmarcLookup: vi.fn(),
	verifyDkim: vi.fn(),
	evaluateDmarc: vi.fn(async () => ({ result: 'pass', policy: 'reject' })),
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn(async () => undefined),
}));
vi.mock('../pipeline.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../pipeline.js')>();
	return { ...actual, runPipeline: vi.fn(async () => ({ kind: 'dropSilently' })) };
});
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { DkimSignatureEvidence } from '@owlat/mail-auth';
import { verifyDkim } from '@owlat/mail-auth';
import type { ResolveTxt } from '@owlat/ostr-client';
import type { MtaConfig } from '../../config.js';
import type { MailboxCacheEntry } from '../../inbound/mailboxResolver.js';
import { runPipeline } from '../pipeline.js';
import { buildOnConnect, buildOnData } from '../server.js';
import { createOstrConsumer } from '../ostrClient.js';
import { reduce } from '../outcome.js';
import type { BasePhaseCtx, BounceAttempt } from '../types.js';

const ZONE = 'ostr.test';
const TRUSTED = 'v=1; tier=trusted; score=82; policy=v1; asof=2026-08-20T00:00:00Z';
const FLAGGED = 'v=1; tier=flagged; score=3; policy=v1; asof=2026-08-20T00:00:00Z';
const IP_NAME = `10.113.0.203.ip.q.${ZONE}`;

const RAW = Buffer.from(
	[
		'From: Sender <sender@example.test>',
		'To: me@org.example',
		'Subject: Hello',
		'Date: Thu, 20 Aug 2026 10:11:12 +0000',
		'Message-ID: <msg-1@example.test>',
		'',
		'Body',
		'',
	].join('\r\n')
);

/** The evidence `@owlat/mail-auth` hands the tap for a passing signature. */
function makeEvidence(overrides: Partial<DkimSignatureEvidence> = {}): DkimSignatureEvidence {
	return {
		signingDomain: 'example.test',
		selector: 's1',
		algorithm: 'rsa-sha256',
		keyBits: 2048,
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'date', 'message-id'],
		rawSignedHeaders: [
			{ name: 'from', raw: 'From: Sender <sender@example.test>' },
			{ name: 'date', raw: 'Date: Thu, 20 Aug 2026 10:11:12 +0000' },
			{ name: 'message-id', raw: 'Message-ID: <msg-1@example.test>' },
		],
		dkimSignatureHeader: 'DKIM-Signature: v=1; a=rsa-sha256; d=example.test; s=s1; b=AAA',
		dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIB',
		verificationVerdict: 'pass',
		bodyHash: 'bh-1',
		...overrides,
	};
}

function makeConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		returnPathDomain: 'bounces.example.test',
		webhookSecret: 'secret',
		inboundDkimEnabled: true,
		inboundDmarcEnabled: false,
		inboundArcEnabled: false,
		bounceMaxConnectionsPerIp: 100,
		bounceTarpitEnabled: false,
		ostrEnabled: false,
		ostrObserverEnabled: false,
		ostrLookupTimeoutMs: 50,
		...overrides,
	} as MtaConfig;
}

/** One store for the per-IP connection counter `onConnect` increments. */
const connectionLimiterRedis = new RedisMock() as unknown as Redis;

/** A TXT resolver over a static zone, counting the names it was asked for. */
function zoneResolver(zone: Record<string, string[][]> = {}): ResolveTxt & { calls: string[] } {
	const calls: string[] = [];
	const resolve = async (name: string) => {
		calls.push(name);
		return zone[name] ?? [];
	};
	return Object.assign(resolve, { calls });
}

function makeResolvers(ostrTxt: ResolveTxt) {
	return { spf: {}, dkim: {}, dmarcTxt: {}, arc: {}, ostrTxt } as never;
}

/**
 * Connect, then deliver — the real sequence, so the connection-time IP lookup
 * and the message-time domain lookup are wired to each other as in production.
 * Returns the ctx `onData` built for the pipeline.
 */
async function runInboundSession(
	config: MtaConfig,
	ostrTxt: ResolveTxt = zoneResolver(),
	remoteAddress = '203.0.113.10'
): Promise<BasePhaseCtx> {
	const consumer = createOstrConsumer(config, { resolveTxt: ostrTxt });
	const ostr = { config, client: consumer?.client ?? null };
	const session = {
		state: {},
		rcptTo: [{ address: 'me@org.example', params: {} }],
		remoteAddress,
		transaction: { spfResult: 'pass', envelopeFromDomain: 'example.test' },
	};

	const onConnect = buildOnConnect(
		config,
		connectionLimiterRedis,
		() => {},
		() => false,
		ostr
	);
	expect(await onConnect(session as never)).toBeUndefined();

	const onData = buildOnData(config, {} as Redis, makeResolvers(ostrTxt), ostr);
	// The tier never gates: whatever the registry said, the message is ACKed.
	expect(await onData(RAW, session as never)).toBeUndefined();
	expect(runPipeline).toHaveBeenCalledTimes(1);
	return vi.mocked(runPipeline).mock.calls[0]?.[2] as BasePhaseCtx;
}

/** `verifyDkim` returning a pass, optionally firing the evidence tap. */
function dkimPasses(evidences: DkimSignatureEvidence[] | null = [makeEvidence()]): void {
	vi.mocked(verifyDkim).mockImplementation(async (_raw, options) => {
		const tap = (options as { onSignatureEvidence?: (e: DkimSignatureEvidence) => void })
			.onSignatureEvidence;
		for (const evidence of evidences ?? []) tap?.(evidence);
		const domains = (evidences ?? [makeEvidence()]).map((e) => e.signingDomain);
		return {
			result: 'pass',
			domain: domains[0] ?? 'example.test',
			passingDomains: domains,
			signatures: domains.map((domain) => ({ verdict: 'pass', domain, selector: 's1' })),
		};
	});
}

/** `verifyDkim` returning a fail; the tap (if handed one) sees a `fail`. */
function dkimFails(): void {
	vi.mocked(verifyDkim).mockImplementation(async (_raw, options) => {
		(options as { onSignatureEvidence?: (e: DkimSignatureEvidence) => void }).onSignatureEvidence?.(
			makeEvidence({ verificationVerdict: 'fail' })
		);
		return {
			result: 'fail',
			domain: 'example.test',
			passingDomains: [],
			signatures: [{ verdict: 'fail', domain: 'example.test', selector: 's1' }],
		};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	dkimPasses();
});

describe('OSTR off — the inbound path is untouched', () => {
	it('issues no lookup and hands the pipeline no ostr fields', async () => {
		const ostrTxt = zoneResolver({
			[`example.test.q.${ZONE}`]: [[TRUSTED]],
			[IP_NAME]: [[FLAGGED]],
		});
		const ctx = await runInboundSession(makeConfig({ ostrZone: ZONE }), ostrTxt);

		expect(ostrTxt.calls).toEqual([]);
		expect('ostrTier' in ctx).toBe(false);
		expect('ostrScore' in ctx).toBe(false);
		expect('ostrDkimEvidence' in ctx).toBe(false);
	});

	it('never arms the evidence tap', async () => {
		await runInboundSession(makeConfig());
		const options = vi.mocked(verifyDkim).mock.calls[0]?.[1];
		expect(options).toBeDefined();
		expect('onSignatureEvidence' in (options as object)).toBe(false);
	});

	it('produces the pre-OSTR mailboxPayload, key for key', async () => {
		// The payload Convex parses is a wire contract, so "off" has to mean the
		// bytes are unchanged — not merely that the new fields read `undefined`.
		const ctx = await runInboundSession(makeConfig());
		expect(Object.keys(mailboxPayload(ctx))).toEqual([
			'deliveryId',
			'recipientAddress',
			'rawBytesBase64',
			'from',
			'to',
			'cc',
			'bcc',
			'replyTo',
			'returnPath',
			'subject',
			'textBody',
			'htmlBody',
			'messageId',
			'inReplyTo',
			'references',
			'date',
			'dkimResult',
			'dmarcResult',
			'dmarcPolicy',
			'arcCv',
			'arcSealerDomain',
			'arcAttestsOriginalPass',
			'attachments',
			'spfResult',
			'envelopeFromDomain',
			'dkimSigningDomain',
		]);
	});
});

describe('OSTR on — the tier travels as a signal', () => {
	it('threads the DKIM-authenticated domain tier through to the payload', async () => {
		const ostrTxt = zoneResolver({
			[`example.test.q.${ZONE}`]: [[TRUSTED]],
			[IP_NAME]: [[FLAGGED]],
		});
		const ctx = await runInboundSession(makeConfig({ ostrEnabled: true, ostrZone: ZONE }), ostrTxt);

		// The IP was asked at CONNECT (once), the domain at DATA; the proven
		// identity wins, so the connection's `flagged` never reaches the payload.
		expect(ostrTxt.calls).toEqual([IP_NAME, `example.test.q.${ZONE}`]);
		expect(ctx.ostrTier).toBe('trusted');
		expect(ctx.ostrScore).toBe(82);

		const payload = mailboxPayload(ctx);
		expect(payload.ostrTier).toBe('trusted');
		expect(payload.ostrScore).toBe(82);
	});

	it('asks about the aligned author domain, not the last signer', async () => {
		// A list re-signed on top: its signature is first in document order, so
		// asking about "the first pass" would score the list for the author's mail.
		dkimPasses([
			makeEvidence({ signingDomain: 'list.example' }),
			makeEvidence({ signingDomain: 'example.test' }),
		]);
		const ostrTxt = zoneResolver({ [`example.test.q.${ZONE}`]: [[TRUSTED]] });
		const ctx = await runInboundSession(makeConfig({ ostrEnabled: true, ostrZone: ZONE }), ostrTxt);

		expect(ostrTxt.calls).toContain(`example.test.q.${ZONE}`);
		expect(ostrTxt.calls).not.toContain(`list.example.q.${ZONE}`);
		expect(ctx.ostrTier).toBe('trusted');
	});

	it('drops the fields when the lookup times out, without stalling the message', async () => {
		const started = Date.now();
		const ctx = await runInboundSession(
			makeConfig({ ostrEnabled: true, ostrZone: ZONE, ostrLookupTimeoutMs: 30 }),
			// Never settles, for either subject.
			() => new Promise(() => {})
		);

		expect('ostrTier' in ctx).toBe(false);
		expect('ostrScore' in ctx).toBe(false);
		// One bounded lookup on the message path, not an unbounded DNS wait.
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('drops the fields when the resolver errors', async () => {
		const ctx = await runInboundSession(
			makeConfig({ ostrEnabled: true, ostrZone: ZONE }),
			async () => {
				throw new Error('SERVFAIL');
			}
		);

		expect('ostrTier' in ctx).toBe(false);
		expect('ostrScore' in ctx).toBe(false);
	});

	it('falls back to the connection IP when no signature verified', async () => {
		dkimFails();
		const ostrTxt = zoneResolver({ [IP_NAME]: [[FLAGGED]] });
		const ctx = await runInboundSession(makeConfig({ ostrEnabled: true, ostrZone: ZONE }), ostrTxt);

		expect(ostrTxt.calls).toEqual([IP_NAME]);
		expect(ctx.ostrTier).toBe('flagged');
	});

	it('folds an IPv4-mapped peer onto the v4 query name', async () => {
		// What a dual-stack listener really reports. Unfolded, this asks for a
		// 32-nibble IPv6 name and every v4 sender is a permanent NXDOMAIN.
		dkimFails();
		const ostrTxt = zoneResolver({ [IP_NAME]: [[FLAGGED]] });
		const ctx = await runInboundSession(
			makeConfig({ ostrEnabled: true, ostrZone: ZONE }),
			ostrTxt,
			'::ffff:203.0.113.10'
		);

		expect(ostrTxt.calls).toEqual([IP_NAME]);
		expect(ctx.ostrTier).toBe('flagged');
	});
});

describe('observer mode — DKIM evidence capture (§7.2)', () => {
	it("arms the tap and attaches the reported signature's evidence", async () => {
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));

		const options = vi.mocked(verifyDkim).mock.calls[0]?.[1];
		expect(typeof (options as { onSignatureEvidence?: unknown }).onSignatureEvidence).toBe(
			'function'
		);
		expect(ctx.ostrDkimEvidence).toMatchObject({
			signingDomain: 'example.test',
			selector: 's1',
			verificationVerdict: 'pass',
		});
		// The instant is the receiver's own: a key record without one is an
		// unfalsifiable claim about DNS at an unspecified time.
		expect(Date.parse(ctx.ostrDkimEvidence?.verifiedAt ?? '')).not.toBeNaN();

		const payload = mailboxPayload(ctx);
		expect(payload.ostrDkimEvidence?.dnsKeyRecordTxt).toBe('v=DKIM1; k=rsa; p=MIIB');
		expect(payload.ostrDkimEvidence?.rawSignedHeaders).toHaveLength(3);
	});

	it('carries a messageId that string-compares with the stored message', async () => {
		// The whole reason the brackets are kept. Asserted off ONE real run, so a
		// hand-made ctx cannot make the two agree when production would not.
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));
		const payload = mailboxPayload(ctx);

		expect(payload.messageId).toBe('<msg-1@example.test>');
		expect(payload.ostrDkimEvidence?.messageId).toBe(payload.messageId);
	});

	it('keeps the aligned author signature when a list signed on top', async () => {
		dkimPasses([
			makeEvidence({ signingDomain: 'list.example' }),
			makeEvidence({ signingDomain: 'example.test' }),
		]);
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));

		expect(ctx.ostrDkimEvidence?.signingDomain).toBe('example.test');
	});

	it('attaches nothing when the signature is not admissible evidence', async () => {
		// An `l=` signature verifies, and proves nothing about the body shown:
		// §7.1 says that is not evidence, so it never leaves this MTA.
		dkimPasses([makeEvidence({ usesBodyLengthTag: true })]);
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));

		expect('ostrDkimEvidence' in ctx).toBe(false);
	});

	it('attaches nothing when no signature verified', async () => {
		dkimFails();
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));

		expect('ostrDkimEvidence' in ctx).toBe(false);
	});

	it('attaches nothing when DKIM never reported (verifier silent)', async () => {
		dkimPasses(null);
		const ctx = await runInboundSession(makeConfig({ ostrObserverEnabled: true }));

		expect('ostrDkimEvidence' in ctx).toBe(false);
	});

	it('is independent of the consumer signal: observer on, OSTR off', async () => {
		const ostrTxt = zoneResolver({ [`example.test.q.${ZONE}`]: [[TRUSTED]] });
		const ctx = await runInboundSession(
			makeConfig({ ostrObserverEnabled: true, ostrZone: ZONE }),
			ostrTxt
		);

		expect(ctx.ostrDkimEvidence).toBeDefined();
		expect(ostrTxt.calls).toEqual([]);
		expect('ostrTier' in ctx).toBe(false);
	});
});

const MAILBOX: MailboxCacheEntry = {
	mailboxId: 'mb-1',
	organizationId: 'org-1',
	usedBytes: 0,
	cachedAt: 0,
};

/**
 * Reduce a personal-mailbox delivery over a ctx `onData` really built, and hand
 * back the payload Convex would get.
 */
function mailboxPayload(ctx: BasePhaseCtx) {
	const attempt: BounceAttempt = {
		kind: 'mailbox',
		mailbox: MAILBOX,
		rcptTo: 'me@org.example',
		attachments: [],
		toAddrs: ['me@org.example'],
		ccAddrs: [],
		bccAddrs: [],
		references: undefined,
	};

	const notify = reduce(attempt, ctx).effects.find((effect) => effect.kind === 'notify_convex');
	if (notify?.kind !== 'notify_convex' || notify.event.mailboxPayload === undefined) {
		throw new Error('no mailbox payload');
	}
	return notify.event.mailboxPayload;
}
