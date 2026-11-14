/**
 * Compose + sign phase (smtp/send/compose.ts): the ACTUAL wire bytes handed to
 * sendEnvelope — alternatives, caller headers, the text fallback, sealed raw
 * MIME passed through untouched, Message-ID policy, and the byte-identical
 * retry across MX hosts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

// Every sendToMx suite stubs the same seams — transport, pool, MX/DANE/STS
// discovery, DKIM keys, logger — so the mock set is built once in
// helpers/senderHarness.ts and registered here.
const harness = await vi.hoisted(async () => {
	const { createSenderHarness } = await import('./helpers/senderHarness.js');
	return createSenderHarness();
});

vi.mock('../../scaling/ipPool.js', () => harness.ipPoolModule());
vi.mock('@owlat/smtp-client', async (importOriginal) =>
	harness.smtpClientModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../connectionPool.js', () => harness.connectionPoolModule());
vi.mock('../mxResolver.js', () => harness.mxResolverModule());
vi.mock('../mxAddresses.js', async (importOriginal) =>
	harness.mxAddressesModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../daneMxResolver.js', () => harness.daneMxResolverModule());
vi.mock('../mtaSts.js', async (importOriginal) =>
	harness.mtaStsModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../dkim.js', () => harness.dkimModule());
vi.mock('../daneResolver.js', () => harness.daneResolverModule());
vi.mock('../../bounce/verp.js', () => harness.verpModule());
vi.mock('../../queue/groups.js', () => harness.queueGroupsModule());
vi.mock('../../monitoring/logger.js', () => harness.loggerModule());

const {
	connectMock,
	sendEnvelopeMock,
	acquireMock,
	releaseMock,
	evictConnectionMock,
	leaseValidMock,
} = harness;

import { generateKeyPairSync } from 'crypto';
import { sendToMx } from '../sender.js';
import { DkimSignatureUnavailableError, getDkimOptions, resolveRequiredDkimKey } from '../dkim.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import {
	createConfig,
	createJob,
	installSenderDefaults,
	okReply,
	smtpError,
} from './helpers/senderFixtures.js';

const privateKey = generateKeyPairSync('rsa', {
	modulusLength: 1024,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

describe('sendToMx message composition', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createConfig();
		installSenderDefaults(harness);
	});

	function rawOf(call = 0): string {
		const options = sendEnvelopeMock.mock.calls[call]?.[1] as { data: Buffer } | undefined;
		if (!options) throw new Error(`sendEnvelope was not called ${call + 1} time(s)`);
		return options.data.toString('utf8');
	}
	function headerBlockOf(call = 0): string {
		return rawOf(call).split('\r\n\r\n')[0]!;
	}
	function headerValueOf(call: number, name: string): string | undefined {
		const re = new RegExp(`^${name}:([\\s\\S]*?)(?:\\r?\\n(?![ \\t]))`, 'im');
		const m = re.exec(rawOf(call) + '\r\n');
		return m ? m[1]!.replace(/\r?\n[ \t]+/g, ' ').trim() : undefined;
	}

	it('forwards an AMP body to the composer as a text/x-amp-html alternative', async () => {
		const amp = '<!doctype html><html ⚡4email><head></head><body>amp</body></html>';

		await sendToMx(createJob({ amp }), config, redis, '10.0.0.1');

		expect(rawOf()).toContain('text/x-amp-html');
	});

	it('omits the amp alternative when the job has no AMP body', async () => {
		await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(rawOf()).not.toContain('x-amp-html');
	});

	it('forwards the campaign List-Unsubscribe headers verbatim (angle brackets, single URL)', async () => {
		const listUnsubscribe = '<https://test.convex.site/unsub/contact-123:1700000000000:sigabc>';
		const job = createJob({
			ipPool: 'campaign',
			headers: {
				'List-Unsubscribe': listUnsubscribe,
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			},
		});

		await sendToMx(job, config, redis, '10.0.0.2');

		expect(headerValueOf(0, 'List-Unsubscribe')).toBe(listUnsubscribe);
		expect(headerValueOf(0, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
	});

	it('spreads job.headers onto the wire (RFC 3834 vacation auto-reply stamps)', async () => {
		const headers = {
			'Auto-Submitted': 'auto-replied',
			'X-Auto-Response-Suppress': 'All',
			Precedence: 'auto_reply',
		};

		await sendToMx(createJob({ headers }), config, redis, '10.0.0.1');

		expect(headerValueOf(0, 'Auto-Submitted')).toBe('auto-replied');
		expect(headerValueOf(0, 'X-Auto-Response-Suppress')).toBe('All');
		expect(headerValueOf(0, 'Precedence')).toBe('auto_reply');
		// The MTA's own tracing headers are added alongside, not replaced.
		expect(headerValueOf(0, 'X-Owlat-Message-Id')).toBe('msg-001');
		expect(headerValueOf(0, 'X-Owlat-Org-Id')).toBe('org-1');
	});

	it('always supplies a non-empty text part (falls back to stripped HTML when the job has no text)', async () => {
		const job = createJob({ html: '<p>Hello there</p>', text: undefined });

		await sendToMx(job, config, redis, '10.0.0.1');

		expect(rawOf()).toContain('Hello there');
		expect(rawOf()).toContain('text/plain');
	});

	it('uses the explicit text part when the job provides one', async () => {
		const job = createJob({ html: '<p>HTML body</p>', text: 'Plain text body' });

		await sendToMx(job, config, redis, '10.0.0.1');

		expect(rawOf()).toContain('Plain text body');
	});

	it('hands sealed Postbox PGP/MIME to the client as exact raw bytes', async () => {
		const mime =
			'From: sender@owlat.com\r\nSubject: sealed\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n\r\nciphertext';

		await sendToMx(
			createJob({ sealedMimeBase64: Buffer.from(mime).toString('base64') }),
			config,
			redis,
			'10.0.0.1'
		);

		// No DKIM key configured (default) → the sealed bytes go on the wire verbatim.
		expect(rawOf()).toBe(mime);
		// The envelope still carries the VERP return-path.
		const env = sendEnvelopeMock.mock.calls[0]![1] as { from: string; to: string[] };
		expect(env.from).toBe('bounce+encoded@bounces.owlat.com');
		expect(env.to).toEqual(['user@example.com']);
	});

	it('composes deterministic bytes for the send (From-aligned, VERP envelope)', async () => {
		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
		expect(result.success).toBe(true);
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
		expect(headerBlockOf(0)).toMatch(/^From: sender@owlat\.com\r?$/m);
		const env = sendEnvelopeMock.mock.calls[0]![1] as { from: string; to: string[] };
		expect(env.from).toBe('bounce+encoded@bounces.owlat.com');
	});

	it('retries the SAME composed+signed bytes across MX hosts (byte-identical — named gate b)', async () => {
		// MX1 fails at a RETRY-SAFE phase (phase 'mail', no reply): the message was
		// not yet transmitted, so the loop advances to MX2. Because the job is
		// composed + signed ONCE up front, MX2 must receive byte-identical bytes.
		sendEnvelopeMock
			.mockRejectedValueOnce(
				smtpError({ phase: 'mail', message: 'connection lost', secured: true })
			)
			.mockResolvedValue({ accepted: [], rejected: [], response: okReply() });

		const result = await sendToMx(
			createJob({ from: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);

		expect(result.success).toBe(true);
		expect(sendEnvelopeMock).toHaveBeenCalledTimes(2); // MX1 failed, MX2 delivered
		// Byte-for-byte identical wire bytes on both attempts (same Message-ID, same
		// Date, same DKIM-Signature would ride these exact bytes) — no per-MX recompose.
		expect(rawOf(0)).toBe(rawOf(1));
	});

	it('emits Date(+0000)/MIME-Version 1.0/From/non-empty To in the generated message', async () => {
		const result = await sendToMx(
			createJob({ from: 'sender@owlat.com', to: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);
		expect(result.success).toBe(true);

		const headers = headerBlockOf(0);
		expect(headers).toMatch(/^Date: .+\+0000$/m);
		expect(headers).not.toMatch(/^Date: .+GMT$/m);
		expect(headers).toMatch(/^MIME-Version: 1\.0\r?$/m);
		expect(headers).toMatch(/^From: sender@owlat\.com\r?$/m);
		const toValue = headerValueOf(0, 'To');
		expect(toValue).toBeDefined();
		expect(toValue).toContain('user@example.com');
	});

	it('stamps a From-domain-aligned Message-ID (not the VERP bounce domain)', async () => {
		config = createConfig({ returnPathDomain: 'bounces.example.com' });

		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const messageId = headerValueOf(0, 'Message-ID');
		expect(messageId).toMatch(/^<[^@>]+@example\.com>$/);
		expect(messageId).not.toContain('bounces.example.com');
	});

	it('sets the Message-ID header exactly once', async () => {
		await sendToMx(createJob({ from: 'user@example.com' }), config, redis, '10.0.0.1');

		const count = (headerBlockOf(0).match(/^Message-ID:/gim) ?? []).length;
		expect(count).toBe(1);
	});

	it('generates a distinct Message-ID for each message', async () => {
		await sendToMx(
			createJob({ messageId: 'msg-001', from: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);
		await sendToMx(
			createJob({ messageId: 'msg-002', from: 'user@example.com' }),
			config,
			redis,
			'10.0.0.1'
		);

		const first = headerValueOf(0, 'Message-ID');
		const second = headerValueOf(1, 'Message-ID');
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});

	it('respects a caller-supplied Message-ID header (does not override)', async () => {
		const supplied = '<agent-reply-123@example.com>';

		await sendToMx(
			createJob({ from: 'user@example.com', headers: { 'Message-ID': supplied } }),
			config,
			redis,
			'10.0.0.1'
		);

		expect(headerValueOf(0, 'Message-ID')).toBe(supplied);
	});

	describe('a message keeps its identity across queue attempts', () => {
		const FIRST_ENQUEUED_AT = Date.parse('2026-06-21T12:00:00Z');

		afterEach(() => {
			vi.useRealTimers();
			vi.mocked(getDkimOptions).mockResolvedValue(undefined);
		});

		/** One queue attempt of the job, with the clock at `at`. */
		async function attemptAt(at: string, job: EmailJob): Promise<void> {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(at));
			const result = await sendToMx(job, config, redis, '10.0.0.1');
			expect(result.success).toBe(true);
		}

		const multipartJob = (): EmailJob =>
			createJob({
				messageId: 'send_abc123',
				from: 'user@example.com',
				html: '<p>Hello <b>world</b></p>',
				text: 'Hello world',
				firstEnqueuedAt: FIRST_ENQUEUED_AT,
			});

		it('puts the same Message-ID, Date, boundaries and signature on the wire on every attempt', async () => {
			vi.mocked(getDkimOptions).mockResolvedValue({
				domainName: 'example.com',
				keySelector: 's1',
				privateKey,
			});

			await attemptAt('2026-06-21T12:00:05Z', multipartJob());
			await attemptAt('2026-06-23T08:30:00Z', multipartJob());

			expect(headerBlockOf(0)).toMatch(/^DKIM-Signature:/m);
			expect(rawOf(1)).toBe(rawOf(0));
		});

		it('dates the message when it was first enqueued, not when the attempt runs', async () => {
			await attemptAt('2026-06-23T08:30:00Z', multipartJob());

			expect(headerValueOf(0, 'Date')).toBe('Sun, 21 Jun 2026 12:00:00 +0000');
		});

		it('derives the Message-ID from the job id and the From domain', async () => {
			await attemptAt('2026-06-21T12:00:05Z', multipartJob());
			await attemptAt('2026-06-21T12:00:05Z', { ...multipartJob(), messageId: 'send_other' });

			const first = headerValueOf(0, 'Message-ID');
			expect(first).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
			expect(headerValueOf(1, 'Message-ID')).not.toBe(first);
		});

		it('never dates a message in the future', async () => {
			await attemptAt('2026-06-21T11:00:00Z', multipartJob());

			expect(headerValueOf(0, 'Date')).toBe('Sun, 21 Jun 2026 11:00:00 +0000');
		});
	});

	describe('a job that requires a DKIM signature', () => {
		afterEach(() => {
			vi.mocked(getDkimOptions).mockResolvedValue(undefined);
		});

		it('opens no connection and sends nothing when no key resolves', async () => {
			vi.mocked(resolveRequiredDkimKey).mockResolvedValue({ kind: 'unavailable', cause: 'no_key' });

			await expect(
				sendToMx(createJob({ requireDkimSignature: true }), config, redis, '10.0.0.1')
			).rejects.toBeInstanceOf(DkimSignatureUnavailableError);

			expect(acquireMock).not.toHaveBeenCalled();
			expect(sendEnvelopeMock).not.toHaveBeenCalled();
		});

		it('refuses to fall back to unsigned bytes when signing throws', async () => {
			vi.mocked(resolveRequiredDkimKey).mockResolvedValue({
				kind: 'key',
				key: { domainName: 'owlat.com', keySelector: 's1', privateKey: 'not a key' },
			});

			await expect(
				sendToMx(createJob({ requireDkimSignature: true }), config, redis, '10.0.0.1')
			).rejects.toMatchObject({ reason: 'sign_failed', domain: 'owlat.com' });
			expect(sendEnvelopeMock).not.toHaveBeenCalled();
		});

		it('goes out signed with the resolved key', async () => {
			vi.mocked(resolveRequiredDkimKey).mockResolvedValue({
				kind: 'key',
				key: { domainName: 'owlat.com', keySelector: 's1', privateKey },
			});

			const result = await sendToMx(
				createJob({ requireDkimSignature: true }),
				config,
				redis,
				'10.0.0.1'
			);

			expect(result.success).toBe(true);
			expect(headerValueOf(0, 'DKIM-Signature')).toMatch(/d=owlat\.com;.*s=s1;/);
		});

		it('keeps shipping unsigned bytes when signing throws for a job without the requirement', async () => {
			vi.mocked(getDkimOptions).mockResolvedValue({
				domainName: 'owlat.com',
				keySelector: 's1',
				privateKey: 'not a key',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(headerBlockOf(0)).not.toMatch(/^DKIM-Signature:/m);
		});
	});
});
