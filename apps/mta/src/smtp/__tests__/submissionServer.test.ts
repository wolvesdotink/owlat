import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SmtpListener, SmtpReply } from '@owlat/smtp-listener';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { lookupCredentialMock, verifyAppPasswordMock } = vi.hoisted(() => ({
	lookupCredentialMock: vi.fn(),
	verifyAppPasswordMock: vi.fn(),
}));
vi.mock('../../auth/credentials.js', () => ({ lookupCredential: lookupCredentialMock }));
vi.mock('../../auth/postboxAuth.js', () => ({ verifyPostboxAppPassword: verifyAppPasswordMock }));

import {
	buildAuthenticate,
	buildOnData,
	buildOnConnect,
	buildOnMailFrom,
	createSlotTracker,
	createSubmissionServer,
	createImplicitTlsSubmissionServer,
	type SubmissionSessionState,
	type AuthenticatedSession,
} from '../submissionServer.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import type { Queue } from 'groupmq';

const config = {
	apiKey: 'master-secret-key',
	submissionMaxAuthFailuresPerIp: 5,
} as MtaConfig;
const redis = {} as never;

// A minimal listener session for driving the exported hooks directly. The hooks
// read only `remoteAddress`, `clientHostname`, `authenticated` and mutate/read
// the typed `state` (which replaces the old `sessionAuth` WeakMap).
interface TestSession {
	remoteAddress: string;
	clientHostname?: string;
	authenticated?: boolean;
	state: SubmissionSessionState;
}

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
	return { remoteAddress: '', state: {}, ...overrides };
}

async function authCall(
	auth: { username?: string; password?: string },
	sessionOverrides: Partial<TestSession> = {},
	r: RealRedis | typeof redis = redis,
	cfg: MtaConfig = config
) {
	const session = makeSession(sessionOverrides);
	const outcome = await buildAuthenticate({ redis: r as never, config: cfg })(
		{ username: auth.username ?? '', password: auth.password ?? '' },
		session as never
	);
	return { outcome, session };
}

async function dataCall(raw: string, auth: AuthenticatedSession | undefined) {
	const queue = { add: vi.fn().mockResolvedValue(undefined) };
	const session = makeSession({ authenticated: auth !== undefined, state: { auth } });
	const reply = await buildOnData({ queue: queue as never })(Buffer.from(raw), session as never);
	return { reply: reply as SmtpReply | undefined, queue };
}

beforeEach(() => {
	lookupCredentialMock.mockReset().mockResolvedValue(null);
	verifyAppPasswordMock.mockReset().mockResolvedValue(null);
});

describe('submission authenticate — auth chain', () => {
	it('accepts the master key and binds a master session', async () => {
		const { outcome, session } = await authCall({ username: 'x', password: 'master-secret-key' });
		expect(outcome).toEqual({ ok: true, user: 'master' });
		expect(session.state.auth).toMatchObject({ organizationId: '__master__' });
	});

	it('rejects a wrong key when no credential matches', async () => {
		const { outcome, session } = await authCall({ username: 'x', password: 'wrong' });
		expect(outcome.ok).toBe(false);
		expect(session.state.auth).toBeUndefined();
	});

	it('rejects an empty password without hitting any backend', async () => {
		const { outcome } = await authCall({ username: 'x', password: '' });
		expect(outcome.ok).toBe(false);
		expect(lookupCredentialMock).not.toHaveBeenCalled();
		expect(verifyAppPasswordMock).not.toHaveBeenCalled();
	});

	it('accepts a per-org credential', async () => {
		lookupCredentialMock.mockResolvedValue({ organizationId: 'org1', name: 'ci-cred' });
		const { outcome, session } = await authCall({ username: 'x', password: 'org-key' });
		expect(outcome).toEqual({ ok: true, user: 'ci-cred' });
		expect(session.state.auth).toMatchObject({ organizationId: 'org1', credentialName: 'ci-cred' });
	});

	it('accepts a Postbox app password and binds the mailbox identity', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		const { outcome, session } = await authCall({
			username: 'Jane@Example.com',
			password: 'app-pass',
		});
		expect(outcome).toEqual({ ok: true, user: 'Jane@Example.com' });
		expect(session.state.auth).toMatchObject({
			postbox: { mailboxAddress: 'jane@example.com', mailboxId: 'mb1' },
		});
	});

	it('skips the app-password round-trip when the username is not an email', async () => {
		const { outcome } = await authCall({ username: 'not-an-email', password: 'whatever' });
		expect(outcome.ok).toBe(false);
		expect(verifyAppPasswordMock).not.toHaveBeenCalled();
	});

	it('forwards the announced EHLO client name so the server can record lastUsedUa', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		await authCall(
			{ username: 'jane@example.com', password: 'app-pass' },
			{ clientHostname: 'thunderbird.local' }
		);
		expect(verifyAppPasswordMock).toHaveBeenCalledWith(
			config,
			'jane@example.com',
			'app-pass',
			'smtp',
			'thunderbird.local'
		);
	});

	it('forwards undefined when no EHLO client name is available', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		await authCall({ username: 'jane@example.com', password: 'app-pass' }, {});
		expect(verifyAppPasswordMock).toHaveBeenCalledWith(
			config,
			'jane@example.com',
			'app-pass',
			'smtp',
			undefined
		);
	});

	it('fails closed when the credential backend throws', async () => {
		lookupCredentialMock.mockRejectedValue(new Error('redis down'));
		const { outcome } = await authCall({ username: 'x', password: 'org-key' });
		expect(outcome.ok).toBe(false);
	});
});

describe('submission onData — recipients, forgery guard, fan-out', () => {
	const baseMime = (from: string, to: string) =>
		`From: ${from}\r\nTo: ${to}\r\nSubject: hello\r\n\r\nbody text\r\n`;

	it('rejects an unauthenticated session', async () => {
		const { reply, queue } = await dataCall(baseMime('a@b.com', 'c@d.com'), undefined);
		expect(reply?.code).toBe(530);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects a message with no recipients', async () => {
		const { reply } = await dataCall('From: a@b.com\r\nSubject: x\r\n\r\nhi\r\n', {
			organizationId: 'org1',
			credentialName: 'cred',
		});
		expect(reply?.code).toBe(554);
	});

	it('rejects a Postbox session forging a different From identity (553 5.7.1)', async () => {
		const { reply, queue } = await dataCall(baseMime('ceo@example.com', 'victim@x.com'), {
			organizationId: 'org1',
			credentialName: 'postbox:jane@example.com',
			postbox: {
				mailboxId: 'mb1',
				mailboxAddress: 'jane@example.com',
				appPasswordId: 'ap1',
				userId: 'u1',
			},
		});
		expect(reply?.code).toBe(553);
		expect(reply?.enhanced).toBe('5.7.1');
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('accepts a Postbox session sending as its own mailbox (case-insensitive)', async () => {
		const { reply, queue } = await dataCall(baseMime('Jane@Example.com', 'friend@x.com'), {
			organizationId: 'org1',
			credentialName: 'postbox:jane@example.com',
			postbox: {
				mailboxId: 'mb1',
				mailboxAddress: 'jane@example.com',
				appPasswordId: 'ap1',
				userId: 'u1',
			},
		});
		expect(reply).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(1);
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.messageId).toMatch(/^pb-smtp-mb1-/);
		expect(job.from).toBe('jane@example.com');
	});

	it('allows master/credential sessions to send any From and fans out per recipient', async () => {
		const mime =
			'From: anyone@brand.com\r\nTo: a@x.com, b@y.com\r\nCc: c@z.com\r\nSubject: s\r\n\r\nhi\r\n';
		const { reply, queue } = await dataCall(mime, {
			organizationId: 'org1',
			credentialName: 'cred',
		});
		expect(reply).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(3);
		const jobs = queue.add.mock.calls.map((c) => c[0].data);
		expect(jobs.map((j) => j.to).sort()).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
		for (const j of jobs) {
			expect(j.organizationId).toBe('org1');
			expect(j.dkimDomain).toBe('brand.com');
			expect(j.messageId).toMatch(/^smtp-/);
		}
	});

	// RFC 2046 §5.1.4: the AMP alternative must survive submission. `parseMessage`
	// neither folds a `text/x-amp-html` part into html/text nor surfaces it as an
	// attachment, so the handler recovers it by walking the MIME tree and sets
	// `job.amp` — preserving the behavior the old mailparser path provided.
	it('recovers the AMP alternative and sets job.amp', async () => {
		const ampBody = '<!doctype html><html ⚡4email><head></head><body>AMP version</body></html>';
		const mime = [
			'From: sender@brand.com',
			'To: rcpt@x.com',
			'Subject: amp newsletter',
			'MIME-Version: 1.0',
			'Content-Type: multipart/alternative; boundary="BOUND"',
			'',
			'--BOUND',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain version',
			'--BOUND',
			'Content-Type: text/x-amp-html; charset=utf-8',
			'',
			ampBody,
			'--BOUND',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html version</p>',
			'--BOUND--',
			'',
		].join('\r\n');

		const { reply, queue } = await dataCall(mime, {
			organizationId: 'org1',
			credentialName: 'cred',
		});
		expect(reply).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(1);
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.amp).toBe(ampBody);
		// The HTML + text alternatives still flow through alongside the AMP part.
		expect(job.html).toContain('html version');
		expect(job.text).toBe('plain version');
	});

	it('recovers a quoted-printable AMP alternative', async () => {
		const mime = [
			'From: sender@brand.com',
			'To: rcpt@x.com',
			'Subject: amp',
			'MIME-Version: 1.0',
			'Content-Type: multipart/alternative; boundary="B"',
			'',
			'--B',
			'Content-Type: text/x-amp-html; charset=utf-8',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'caf=C3=A9 amp',
			'--B--',
			'',
		].join('\r\n');
		const { queue } = await dataCall(mime, { organizationId: 'org1', credentialName: 'cred' });
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.amp).toBe('café amp');
	});

	// Sanctioned divergence (enumerated in the PR body): a multi-line AMP document
	// arrives over the wire CRLF-delimited, but `MimeNode.rawBody` CRLF→LF
	// normalizes nested non-message/* leaves (mailMime parity), so `job.amp` carries
	// LF line endings. This is immaterial downstream — the sender re-encodes the
	// part with canonical CRLF on the way out — but it IS a byte change from the old
	// mailparser path, so pin it explicitly rather than leave it silent.
	it('recovers a MULTI-LINE AMP alternative with LF-normalized line endings', async () => {
		const ampLines = [
			'<!doctype html>',
			'<html ⚡4email>',
			'<head></head>',
			'<body>AMP line one',
			'line two</body>',
			'</html>',
		];
		const mime = [
			'From: sender@brand.com',
			'To: rcpt@x.com',
			'Subject: multiline amp',
			'MIME-Version: 1.0',
			'Content-Type: multipart/alternative; boundary="BOUND"',
			'',
			'--BOUND',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain version',
			'--BOUND',
			'Content-Type: text/x-amp-html; charset=utf-8',
			'',
			...ampLines,
			'--BOUND--',
			'',
		].join('\r\n');

		const { queue } = await dataCall(mime, { organizationId: 'org1', credentialName: 'cred' });
		const job = queue.add.mock.calls[0]![0].data;
		// LF-joined (NOT CRLF) — the enumerated normalization.
		expect(job.amp).toBe(ampLines.join('\n'));
		expect(job.amp).not.toContain('\r');
	});

	it('leaves job.amp unset when the message has no AMP part', async () => {
		const { reply, queue } = await dataCall(baseMime('sender@brand.com', 'rcpt@x.com'), {
			organizationId: 'org1',
			credentialName: 'cred',
		});
		expect(reply).toBeUndefined();
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.amp).toBeUndefined();
	});

	// Regression-lock the DKIM identifier-alignment invariant for the submission
	// path: the queued job's dkimDomain MUST equal the RFC5322.From domain (never
	// the recipient domain), because the worker signs with the dkimDomain key and
	// DMARC (RFC 7489 §3.1.1) only passes when the DKIM d= aligns with From.
	it('sets queued dkimDomain to the From domain (DKIM alignment, RFC 7489 §3.1.1)', async () => {
		const { reply, queue } = await dataCall(
			baseMime('Sales <sales@SenderBrand.com>', 'rcpt@recipientdomain.net'),
			{ organizationId: 'org1', credentialName: 'cred' }
		);
		expect(reply).toBeUndefined();
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.dkimDomain).toBe('senderbrand.com');
		expect(job.dkimDomain).toBe((job.from as string).split('@')[1]);
		expect(job.dkimDomain).not.toBe('recipientdomain.net');
	});
});

describe('submission authenticate — per-IP brute-force throttle', () => {
	let liveRedis: RealRedis;
	const throttleConfig = {
		apiKey: 'master-secret-key',
		submissionMaxAuthFailuresPerIp: 3,
	} as MtaConfig;

	function authCallIp(
		auth: { username?: string; password?: string },
		remoteIp: string,
		r: RealRedis
	) {
		return authCall(auth, { remoteAddress: remoteIp }, r, throttleConfig);
	}

	const authKey = (ip: string) => `mta:submission:authfail:${ip}`;

	beforeEach(() => {
		liveRedis = new Redis() as unknown as RealRedis;
	});

	it('records a failure when the MASTER key is wrong', async () => {
		expect(await liveRedis.get(authKey('1.2.3.4'))).toBeNull();
		const { outcome } = await authCallIp(
			{ username: 'x', password: 'not-the-master' },
			'1.2.3.4',
			liveRedis
		);
		expect(outcome.ok).toBe(false);
		expect(await liveRedis.get(authKey('1.2.3.4'))).toBe('1');
	});

	it('records a failure when an org credential lookup misses', async () => {
		lookupCredentialMock.mockResolvedValue(null);
		const { outcome } = await authCallIp(
			{ username: 'x', password: 'wrong-org-key' },
			'9.9.9.9',
			liveRedis
		);
		expect(outcome.ok).toBe(false);
		expect(await liveRedis.get(authKey('9.9.9.9'))).toBe('1');
	});

	it('throttles AUTH once the per-IP failure budget is exhausted — reply-identical to a wrong secret', async () => {
		// Burn the budget (3 failures).
		for (let i = 0; i < 3; i++) {
			const { outcome } = await authCallIp(
				{ username: 'x', password: 'nope' },
				'5.5.5.5',
				liveRedis
			);
			expect(outcome.ok).toBe(false);
		}
		// The 4th attempt is refused by the throttle BEFORE comparing the secret —
		// even the correct master key is rejected while locked out, and the outcome
		// is byte-identical to a normal rejection (no auth oracle — D6).
		const { outcome } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'5.5.5.5',
			liveRedis
		);
		expect(outcome).toEqual({ ok: false });
	});

	it('clears the failure counter after a successful auth', async () => {
		await authCallIp({ username: 'x', password: 'nope' }, '7.7.7.7', liveRedis);
		expect(await liveRedis.get(authKey('7.7.7.7'))).toBe('1');
		const { outcome } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'7.7.7.7',
			liveRedis
		);
		expect(outcome).toEqual({ ok: true, user: 'master' });
		expect(await liveRedis.get(authKey('7.7.7.7'))).toBeNull();
	});

	it('tracks failures per IP independently', async () => {
		for (let i = 0; i < 3; i++) {
			await authCallIp({ username: 'x', password: 'nope' }, '1.1.1.1', liveRedis);
		}
		// A different IP is still allowed to attempt (and succeed).
		const { outcome } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'2.2.2.2',
			liveRedis
		);
		expect(outcome).toEqual({ ok: true, user: 'master' });
	});
});

describe('submission listener — TLS guard + connection limiting', () => {
	const queue = { add: vi.fn() } as unknown as Queue<EmailJob>;

	// The listener validates the PEM when it builds its secure context, so the
	// happy-path tests need real TLS material. Generate a throwaway pair once.
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-submission-test-'));
		try {
			execFileSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'1',
				'-nodes',
				'-subj',
				'/CN=mta.test',
			]);
			certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
			keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const tlsConfig = (overrides: Partial<MtaConfig> = {}): MtaConfig =>
		({
			apiKey: 'master-secret-key',
			ehloHostname: 'mta.test',
			submissionTlsCert: certPem,
			submissionTlsKey: keyPem,
			submissionMaxClients: 200,
			submissionMaxConnectionsPerIp: 3,
			submissionMaxAuthFailuresPerIp: 10,
			...overrides,
		}) as MtaConfig;

	it('THROWS when the TLS cert is undefined', () => {
		expect(() =>
			createSubmissionServer(queue, redis, tlsConfig({ submissionTlsCert: undefined }))
		).toThrow(/SUBMISSION_TLS_CERT/);
	});

	it('THROWS when the TLS key is undefined', () => {
		expect(() =>
			createSubmissionServer(queue, redis, tlsConfig({ submissionTlsKey: undefined }))
		).toThrow(/SUBMISSION_TLS_KEY/);
	});

	it('THROWS when both cert and key are undefined', () => {
		expect(() =>
			createSubmissionServer(
				queue,
				redis,
				tlsConfig({ submissionTlsCert: undefined, submissionTlsKey: undefined })
			)
		).toThrow(/Refusing to start an insecure submission listener/);
	});

	it('applies the global maxClients cap via the raw server backpressure', () => {
		// The listener is not bound here (no listen()), so its net.Server holds no
		// FD — only the accept-backpressure cap is asserted.
		const server = createSubmissionServer(queue, redis, tlsConfig());
		expect(server.raw.maxConnections).toBe(200);
	});

	it('the per-IP onConnect limiter rejects the N+1th connection', async () => {
		const liveRedis = new Redis() as unknown as RealRedis;
		const onConnect = buildOnConnect({
			redis: liveRedis,
			config: tlsConfig({ submissionMaxConnectionsPerIp: 3 }),
		});

		const connect = (ip: string) =>
			onConnect({ remoteAddress: ip, state: {} } as never) as Promise<SmtpReply | undefined>;

		// First 3 from the same IP are allowed…
		expect(await connect('8.8.8.8')).toBeUndefined();
		expect(await connect('8.8.8.8')).toBeUndefined();
		expect(await connect('8.8.8.8')).toBeUndefined();
		// …the 4th is rejected by the per-IP cap with a 421.
		const fourth = await connect('8.8.8.8');
		expect(fourth?.code).toBe(421);
		expect(String(fourth?.text)).toMatch(/Too many connections/);
		// A different IP is unaffected.
		expect(await connect('8.8.4.4')).toBeUndefined();
	});

	// The slot-taken callback is the release contract: it fires for — and ONLY for —
	// connections that actually held a slot (net +1 on the counter). A rejected
	// (over-cap) connection is incremented-then-decremented inside the limiter
	// (net 0) and MUST NOT be marked, else its socket close would over-decrement
	// (the 465 cap-bypass / 587 double-decrement class of bug).
	it('marks the slot held only for connections that took a slot (not the rejected N+1th)', async () => {
		const liveRedis = new Redis() as unknown as RealRedis;
		const held: string[] = [];
		const onConnect = buildOnConnect(
			{ redis: liveRedis, config: tlsConfig({ submissionMaxConnectionsPerIp: 2 }) },
			(session) => held.push(`${session.remoteAddress}:${session.remotePort}`)
		);
		const connect = (ip: string, port: number) =>
			onConnect({ remoteAddress: ip, remotePort: port, state: {} } as never) as Promise<
				SmtpReply | undefined
			>;

		expect(await connect('9.9.9.9', 1001)).toBeUndefined(); // slot 1 — held
		expect(await connect('9.9.9.9', 1002)).toBeUndefined(); // slot 2 — held
		const third = await connect('9.9.9.9', 1003); // over cap — rejected, NOT held
		expect(third?.code).toBe(421);

		// Only the two allowed connections were marked; the refused one was not.
		expect(held).toEqual(['9.9.9.9:1001', '9.9.9.9:1002']);
	});
});

// The slot tracker reconciles the per-IP counter's increments against socket
// lifetime. `checkConnectionRateLimit` is async, so a connection can close while
// its rate-limit round-trip is still pending (immediate-RST connects — port scans
// / LB health probes). Every KEPT increment must be released EXACTLY once, in
// whichever order the socket-close and the slot-held callback fire.
describe('submission slot tracker — increment/lifetime reconciliation', () => {
	const connKey = (ip: string) => `mta:submission:conn:${ip}`;
	// Let the async releaseConnection (decr + possibly del) settle.
	const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

	function fakeSocket(remoteAddress: string, remotePort: number): net.Socket {
		const sock = new EventEmitter() as unknown as net.Socket;
		(sock as { remoteAddress?: string }).remoteAddress = remoteAddress;
		(sock as { remotePort?: number }).remotePort = remotePort;
		return sock;
	}
	const session = (remoteAddress: string, remotePort: number) =>
		({ remoteAddress, remotePort, state: {} }) as never;

	it('releases a held slot exactly once when the socket closes after hold()', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r);
		const sock = fakeSocket('7.7.7.7', 2001);
		tracker.track(sock); // TCP accept — live
		await r.incr(connKey('7.7.7.7')); // onConnect kept a slot (net +1)
		tracker.hold(session('7.7.7.7', 2001)); // still live → mark for release on close
		expect(await r.get(connKey('7.7.7.7'))).toBe('1'); // not released yet
		sock.emit('close');
		await flush();
		expect(await r.get(connKey('7.7.7.7'))).toBeNull(); // released, key cleaned up
	});

	it('self-heals the race: a connection that closes BEFORE hold() still releases its slot', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r);
		const sock = fakeSocket('6.6.6.6', 3003);
		tracker.track(sock); // accept — live
		await r.incr(connKey('6.6.6.6')); // rate-limit check kept the increment (in flight)
		sock.emit('close'); // client RST before hold(): live deleted, held miss → no release
		await flush();
		expect(await r.get(connKey('6.6.6.6'))).toBe('1'); // the leak-prone window
		tracker.hold(session('6.6.6.6', 3003)); // reconciles: no longer live → release now
		await flush();
		expect(await r.get(connKey('6.6.6.6'))).toBeNull(); // released exactly once
	});

	it('never releases a slot for a connection that never took one', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r);
		const sock = fakeSocket('5.5.5.5', 4004);
		tracker.track(sock);
		await r.incr(connKey('5.5.5.5')); // a different connection's live slot
		sock.emit('close'); // this socket never called hold() → must not decrement
		await flush();
		expect(await r.get(connKey('5.5.5.5'))).toBe('1'); // untouched
	});
});

describe('submission onMailFrom — require-auth-before-MAIL gate', () => {
	it('refuses MAIL FROM with 530 5.7.0 until AUTH has succeeded, then accepts', () => {
		const onMailFrom = buildOnMailFrom();
		const addr = { address: 'x@y.com', params: {} };

		const refused = onMailFrom(addr, { authenticated: false, state: {} } as never) as SmtpReply;
		expect(refused).toMatchObject({ code: 530, enhanced: '5.7.0' });

		const accepted = onMailFrom(addr, { authenticated: true, state: {} } as never);
		expect(accepted).toBeUndefined();
	});
});

// ── Wire-level TLS gate tests ───────────────────────────────────────────────
//
// (1) The 587 listener refuses AUTH before STARTTLS (530) and never reaches the
//     credential check (RFC 3207 / RFC 4954 §4 / RFC 8314 §3.3); after STARTTLS
//     the master key authenticates (235). A CORRECT master key rejected with 530
//     (not 235) proves the credential path was never entered.
// (2) The implicit-TLS (465) listener is encrypted from the first byte (RFC 8314
//     §3.3/§7.3 preferred), serves its 220 banner + AUTH over TLS, and a plaintext
//     client cannot complete the handshake.
describe('submission TLS gate — wire-level', () => {
	const queue = { add: vi.fn() } as unknown as Queue<EmailJob>;
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-submission-tls-test-'));
		try {
			execFileSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'1',
				'-nodes',
				'-subj',
				'/CN=mta.test',
			]);
			certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
			keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const tlsConfig = (overrides: Partial<MtaConfig> = {}): MtaConfig =>
		({
			apiKey: 'master-secret-key',
			ehloHostname: 'mta.test',
			submissionTlsCert: certPem,
			submissionTlsKey: keyPem,
			submissionMaxClients: 200,
			submissionMaxConnectionsPerIp: 100,
			submissionMaxAuthFailuresPerIp: 100,
			...overrides,
		}) as MtaConfig;

	async function boot(listener: SmtpListener): Promise<number> {
		await listener.listen(0, '127.0.0.1');
		return (listener.address() as AddressInfo).port;
	}

	type Conn = net.Socket | tls.TLSSocket;

	/** Read until a complete SMTP reply arrives (final line is `NNN<space>`). */
	function readReply(conn: Conn): Promise<string> {
		return new Promise((resolve, reject) => {
			let buf = '';
			const onData = (chunk: Buffer) => {
				buf += chunk.toString('utf8');
				const lines = buf.split('\r\n').filter(Boolean);
				const last = lines[lines.length - 1];
				if (last && /^\d{3} /.test(last)) {
					cleanup();
					resolve(buf);
				}
			};
			const onErr = (err: Error) => {
				cleanup();
				reject(err);
			};
			const cleanup = () => {
				conn.off('data', onData);
				conn.off('error', onErr);
			};
			conn.on('data', onData);
			conn.on('error', onErr);
		});
	}

	function send(conn: Conn, line: string): void {
		conn.write(`${line}\r\n`);
	}

	const plainAuth = (user: string, pass: string): string =>
		Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');

	it('587: refuses AUTH before STARTTLS (530) without reaching the credential check, then authenticates after STARTTLS', async () => {
		const server = createSubmissionServer(queue, new Redis() as unknown as RealRedis, tlsConfig());
		const port = await boot(server);
		try {
			const sock = net.connect(port, '127.0.0.1');
			await new Promise<void>((res) => sock.once('connect', () => res()));

			// 220 greeting (plaintext channel pre-STARTTLS).
			expect(await readReply(sock)).toMatch(/^220 /);

			send(sock, 'EHLO client.test');
			const ehlo = await readReply(sock);
			expect(ehlo).toMatch(/250[ -]/);
			// STARTTLS must be advertised since we connect over plaintext.
			expect(ehlo).toMatch(/STARTTLS/);

			// AUTH PLAIN with the CORRECT master key — but BEFORE STARTTLS. The
			// listener must refuse it with 530 (encryption required) and never run
			// the credential check (a reached-and-correct key would be 235).
			send(sock, `AUTH PLAIN ${plainAuth('master', 'master-secret-key')}`);
			const preAuthReply = await readReply(sock);
			expect(preAuthReply).toMatch(/^530 /);
			expect(preAuthReply).toMatch(/Must issue a STARTTLS command first/i);

			// Upgrade the channel: STARTTLS → 220, then wrap the socket in TLS.
			send(sock, 'STARTTLS');
			expect(await readReply(sock)).toMatch(/^220 /);

			const secure = tls.connect({ socket: sock, rejectUnauthorized: false });
			await new Promise<void>((res, rej) => {
				secure.once('secureConnect', () => res());
				secure.once('error', rej);
			});

			// Re-EHLO over the encrypted channel, then AUTH the master key → 235.
			send(secure, 'EHLO client.test');
			expect(await readReply(secure)).toMatch(/250[ -]/);

			send(secure, `AUTH PLAIN ${plainAuth('master', 'master-secret-key')}`);
			expect(await readReply(secure)).toMatch(/^235 /);

			secure.destroy();
		} finally {
			await server.close();
		}
	});

	// The require-auth-before-MAIL gate on the wire: over the secured channel, MAIL
	// FROM before AUTH is refused 530 5.7.0 (submission never relays unauthenticated);
	// after a successful 235 the very same MAIL FROM is accepted 250. Exercises the
	// live onMailFrom hook, not buildOnData's defense-in-depth 530.
	it('587: refuses MAIL FROM before AUTH (530), accepts it after AUTH (250)', async () => {
		const server = createSubmissionServer(queue, new Redis() as unknown as RealRedis, tlsConfig());
		const port = await boot(server);
		try {
			const sock = net.connect(port, '127.0.0.1');
			await new Promise<void>((res) => sock.once('connect', () => res()));
			expect(await readReply(sock)).toMatch(/^220 /);

			send(sock, 'EHLO client.test');
			expect(await readReply(sock)).toMatch(/250[ -]/);

			send(sock, 'STARTTLS');
			expect(await readReply(sock)).toMatch(/^220 /);

			const secure = tls.connect({ socket: sock, rejectUnauthorized: false });
			await new Promise<void>((res, rej) => {
				secure.once('secureConnect', () => res());
				secure.once('error', rej);
			});

			send(secure, 'EHLO client.test');
			expect(await readReply(secure)).toMatch(/250[ -]/);

			// Secured but NOT authenticated: MAIL FROM must be refused 530 5.7.0.
			send(secure, 'MAIL FROM:<sender@brand.com>');
			const preAuth = await readReply(secure);
			expect(preAuth).toMatch(/^530 /);
			expect(preAuth).toMatch(/5\.7\.0/);

			// Authenticate, then the same MAIL FROM is accepted 250.
			send(secure, `AUTH PLAIN ${plainAuth('master', 'master-secret-key')}`);
			expect(await readReply(secure)).toMatch(/^235 /);

			send(secure, 'MAIL FROM:<sender@brand.com>');
			expect(await readReply(secure)).toMatch(/^250 /);

			secure.destroy();
		} finally {
			await server.close();
		}
	});

	it('465: implicit TLS serves the 220 banner + AUTH over the encrypted channel', async () => {
		const server = createImplicitTlsSubmissionServer(
			queue,
			new Redis() as unknown as RealRedis,
			tlsConfig()
		);
		const port = await boot(server);
		try {
			const secure = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
			await new Promise<void>((res, rej) => {
				secure.once('secureConnect', () => res());
				secure.once('error', rej);
			});
			// The banner itself arrives over the already-encrypted channel.
			expect(secure.encrypted).toBe(true);
			expect(await readReply(secure)).toMatch(/^220 /);

			send(secure, 'EHLO client.test');
			expect(await readReply(secure)).toMatch(/250[ -]/);

			send(secure, `AUTH PLAIN ${plainAuth('master', 'master-secret-key')}`);
			expect(await readReply(secure)).toMatch(/^235 /);

			secure.destroy();
		} finally {
			await server.close();
		}
	});

	it('465: a plaintext client cannot complete the implicit-TLS handshake', async () => {
		const server = createImplicitTlsSubmissionServer(
			queue,
			new Redis() as unknown as RealRedis,
			tlsConfig()
		);
		const port = await boot(server);
		try {
			// Plaintext connect: the server speaks TLS from the first byte, so it
			// never emits a 220 SMTP banner. A plaintext EHLO is a malformed
			// ClientHello and the connection is torn down — no greeting.
			const result = await new Promise<'no-banner' | 'banner'>((resolve, reject) => {
				const sock = net.connect(port, '127.0.0.1');
				let sawBanner = false;
				const timer = setTimeout(() => {
					sock.destroy();
					resolve(sawBanner ? 'banner' : 'no-banner');
				}, 500);
				sock.on('connect', () => send(sock, 'EHLO client.test'));
				sock.on('data', (chunk: Buffer) => {
					if (chunk.toString('utf8').startsWith('220 ')) sawBanner = true;
				});
				sock.on('error', () => {
					clearTimeout(timer);
					resolve('no-banner');
				});
				sock.on('close', () => {
					clearTimeout(timer);
					resolve(sawBanner ? 'banner' : 'no-banner');
				});
				sock.on('timeout', () => reject(new Error('unexpected socket timeout')));
			});
			expect(result).toBe('no-banner');
		} finally {
			await server.close();
		}
	});
});
