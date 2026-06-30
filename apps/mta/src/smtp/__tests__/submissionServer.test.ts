import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { SMTPServer } from 'smtp-server';
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
	buildOnAuth,
	buildOnData,
	createSubmissionServer,
	createImplicitTlsSubmissionServer,
	sessionAuth,
} from '../submissionServer.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import type { Queue } from 'groupmq';

const config = {
	apiKey: 'master-secret-key',
	submissionMaxAuthFailuresPerIp: 5,
} as MtaConfig;
const redis = {} as never;

function authCall(auth: { username?: string; password?: string }, session: object = {}) {
	return new Promise<{ err: Error | null; user?: string; session: object }>((resolve) => {
		void buildOnAuth({ redis, config })(auth, session, (err, response) => {
			resolve({ err, user: response?.user, session });
		});
	});
}

function mimeStream(raw: string) {
	const s = new PassThrough() as PassThrough & { sizeExceeded?: boolean };
	s.sizeExceeded = false;
	s.end(raw);
	return s;
}

function dataCall(raw: string, session: object) {
	const queue = { add: vi.fn().mockResolvedValue(undefined) };
	return new Promise<{ err?: Error | null; queue: typeof queue }>((resolve) => {
		void buildOnData({ queue: queue as never })(mimeStream(raw), session, (err) => {
			resolve({ err, queue });
		});
	});
}

beforeEach(() => {
	lookupCredentialMock.mockReset().mockResolvedValue(null);
	verifyAppPasswordMock.mockReset().mockResolvedValue(null);
});

describe('submission onAuth — auth chain', () => {
	it('accepts the master key and binds a master session', async () => {
		const { err, user, session } = await authCall({ username: 'x', password: 'master-secret-key' });
		expect(err).toBeNull();
		expect(user).toBe('master');
		expect(sessionAuth.get(session)).toMatchObject({ organizationId: '__master__' });
	});

	it('rejects a wrong key when no credential matches', async () => {
		const { err } = await authCall({ username: 'x', password: 'wrong' });
		expect(err?.message).toBe('Authentication failed');
	});

	it('rejects an empty password without hitting any backend', async () => {
		const { err } = await authCall({ username: 'x', password: '' });
		expect(err?.message).toBe('Authentication failed');
		expect(lookupCredentialMock).not.toHaveBeenCalled();
		expect(verifyAppPasswordMock).not.toHaveBeenCalled();
	});

	it('accepts a per-org credential', async () => {
		lookupCredentialMock.mockResolvedValue({ organizationId: 'org1', name: 'ci-cred' });
		const { err, user, session } = await authCall({ username: 'x', password: 'org-key' });
		expect(err).toBeNull();
		expect(user).toBe('ci-cred');
		expect(sessionAuth.get(session)).toMatchObject({ organizationId: 'org1', credentialName: 'ci-cred' });
	});

	it('accepts a Postbox app password and binds the mailbox identity', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		const { err, user, session } = await authCall({ username: 'Jane@Example.com', password: 'app-pass' });
		expect(err).toBeNull();
		expect(user).toBe('Jane@Example.com');
		expect(sessionAuth.get(session)).toMatchObject({
			postbox: { mailboxAddress: 'jane@example.com', mailboxId: 'mb1' },
		});
	});

	it('skips the app-password round-trip when the username is not an email', async () => {
		const { err } = await authCall({ username: 'not-an-email', password: 'whatever' });
		expect(err?.message).toBe('Authentication failed');
		expect(verifyAppPasswordMock).not.toHaveBeenCalled();
	});

	it('forwards the EHLO client name so the server can record lastUsedUa', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		await authCall(
			{ username: 'jane@example.com', password: 'app-pass' },
			{ hostNameAppearsAs: 'thunderbird.local' },
		);
		expect(verifyAppPasswordMock).toHaveBeenCalledWith(
			config,
			'jane@example.com',
			'app-pass',
			'smtp',
			'thunderbird.local',
		);
	});

	it('falls back to the resolved client hostname when no EHLO name is set', async () => {
		verifyAppPasswordMock.mockResolvedValue({
			organizationId: 'org1',
			mailboxId: 'mb1',
			appPasswordId: 'ap1',
			userId: 'u1',
		});
		await authCall(
			{ username: 'jane@example.com', password: 'app-pass' },
			{ clientHostname: 'mail.client.example' },
		);
		expect(verifyAppPasswordMock).toHaveBeenCalledWith(
			config,
			'jane@example.com',
			'app-pass',
			'smtp',
			'mail.client.example',
		);
	});

	it('forwards undefined when neither EHLO nor hostname is available', async () => {
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
			undefined,
		);
	});

	it('fails closed when the credential backend throws', async () => {
		lookupCredentialMock.mockRejectedValue(new Error('redis down'));
		const { err } = await authCall({ username: 'x', password: 'org-key' });
		expect(err?.message).toBe('Authentication failed');
	});
});

describe('submission onData — recipients, forgery guard, fan-out', () => {
	const baseMime = (from: string, to: string) =>
		`From: ${from}\r\nTo: ${to}\r\nSubject: hello\r\n\r\nbody text\r\n`;

	it('rejects an unauthenticated session', async () => {
		const { err, queue } = await dataCall(baseMime('a@b.com', 'c@d.com'), {});
		expect(err?.message).toBe('Not authenticated');
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects a message with no recipients', async () => {
		const session = {};
		sessionAuth.set(session, { organizationId: 'org1', credentialName: 'cred' });
		const { err } = await dataCall('From: a@b.com\r\nSubject: x\r\n\r\nhi\r\n', session);
		expect(err?.message).toBe('No valid recipients');
	});

	it('rejects a Postbox session forging a different From identity', async () => {
		const session = {};
		sessionAuth.set(session, {
			organizationId: 'org1',
			credentialName: 'postbox:jane@example.com',
			postbox: { mailboxId: 'mb1', mailboxAddress: 'jane@example.com', appPasswordId: 'ap1', userId: 'u1' },
		});
		const { err, queue } = await dataCall(baseMime('ceo@example.com', 'victim@x.com'), session);
		expect(err?.message).toContain('553 5.7.1');
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('accepts a Postbox session sending as its own mailbox (case-insensitive)', async () => {
		const session = {};
		sessionAuth.set(session, {
			organizationId: 'org1',
			credentialName: 'postbox:jane@example.com',
			postbox: { mailboxId: 'mb1', mailboxAddress: 'jane@example.com', appPasswordId: 'ap1', userId: 'u1' },
		});
		const { err, queue } = await dataCall(baseMime('Jane@Example.com', 'friend@x.com'), session);
		expect(err).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(1);
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.messageId).toMatch(/^pb-smtp-mb1-/);
		expect(job.from).toBe('jane@example.com');
	});

	it('allows master/credential sessions to send any From and fans out per recipient', async () => {
		const session = {};
		sessionAuth.set(session, { organizationId: 'org1', credentialName: 'cred' });
		const mime =
			'From: anyone@brand.com\r\nTo: a@x.com, b@y.com\r\nCc: c@z.com\r\nSubject: s\r\n\r\nhi\r\n';
		const { err, queue } = await dataCall(mime, session);
		expect(err).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(3);
		const jobs = queue.add.mock.calls.map((c) => c[0].data);
		expect(jobs.map((j) => j.to).sort()).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
		for (const j of jobs) {
			expect(j.organizationId).toBe('org1');
			expect(j.dkimDomain).toBe('brand.com');
			expect(j.messageId).toMatch(/^smtp-/);
		}
	});

	// PR-51 (RFC 2046 §5.1.4): the 587 submission path parsed but DROPPED the
	// AMP alternative — mailparser surfaces `text/x-amp-html` as an attachment
	// (no `parsed.amp`), so it never reached the EmailJob. The handler now
	// recovers it and sets `job.amp`.
	it('recovers the AMP alternative and sets job.amp', async () => {
		const session = {};
		sessionAuth.set(session, { organizationId: 'org1', credentialName: 'cred' });
		const ampBody =
			'<!doctype html><html ⚡4email><head></head><body>AMP version</body></html>';
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

		const { err, queue } = await dataCall(mime, session);
		expect(err).toBeUndefined();
		expect(queue.add).toHaveBeenCalledTimes(1);
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.amp).toBe(ampBody);
		// The HTML + text alternatives still flow through alongside the AMP part.
		expect(job.html).toContain('html version');
		expect(job.text).toBe('plain version');
	});

	it('leaves job.amp unset when the message has no AMP part', async () => {
		const session = {};
		sessionAuth.set(session, { organizationId: 'org1', credentialName: 'cred' });
		const { err, queue } = await dataCall(baseMime('sender@brand.com', 'rcpt@x.com'), session);
		expect(err).toBeUndefined();
		const job = queue.add.mock.calls[0]![0].data;
		expect(job.amp).toBeUndefined();
	});

	// PR-27 — Regression-lock the DKIM identifier-alignment invariant for the 587
	// submission path: the queued job's dkimDomain MUST equal the RFC5322.From
	// domain (never the recipient domain, never the EHLO host), because the worker
	// signs with the dkimDomain key and DMARC (RFC 7489 §3.1.1) only passes when
	// the DKIM d= aligns with From. The From domain here is deliberately distinct
	// from both the recipient domain and any local part so a wrong derivation
	// (e.g. recipient-domain) would visibly fail.
	it('sets queued dkimDomain to the From domain (DKIM alignment, RFC 7489 §3.1.1)', async () => {
		const session = {};
		sessionAuth.set(session, { organizationId: 'org1', credentialName: 'cred' });
		const { err, queue } = await dataCall(
			baseMime('Sales <sales@SenderBrand.com>', 'rcpt@recipientdomain.net'),
			session,
		);
		expect(err).toBeUndefined();
		const job = queue.add.mock.calls[0]![0].data;
		// Lowercased From domain — not the recipient domain.
		expect(job.dkimDomain).toBe('senderbrand.com');
		expect(job.dkimDomain).toBe((job.from as string).split('@')[1]);
		expect(job.dkimDomain).not.toBe('recipientdomain.net');
	});
});

describe('submission onAuth — per-IP brute-force throttle', () => {
	let liveRedis: RealRedis;
	const throttleConfig = { apiKey: 'master-secret-key', submissionMaxAuthFailuresPerIp: 3 } as MtaConfig;

	function authCallIp(
		auth: { username?: string; password?: string },
		remoteIp: string,
		r: RealRedis,
	) {
		const session = { remoteAddress: remoteIp };
		return new Promise<{ err: Error | null; user?: string }>((resolve) => {
			void buildOnAuth({ redis: r, config: throttleConfig })(auth, session, (err, response) => {
				resolve({ err, user: response?.user });
			});
		});
	}

	const authKey = (ip: string) => `mta:submission:authfail:${ip}`;

	beforeEach(() => {
		liveRedis = new Redis() as unknown as RealRedis;
	});

	it('records a failure when the MASTER key is wrong', async () => {
		expect(await liveRedis.get(authKey('1.2.3.4'))).toBeNull();
		const { err } = await authCallIp({ username: 'x', password: 'not-the-master' }, '1.2.3.4', liveRedis);
		expect(err?.message).toBe('Authentication failed');
		expect(await liveRedis.get(authKey('1.2.3.4'))).toBe('1');
	});

	it('records a failure when an org credential lookup misses', async () => {
		lookupCredentialMock.mockResolvedValue(null);
		const { err } = await authCallIp({ username: 'x', password: 'wrong-org-key' }, '9.9.9.9', liveRedis);
		expect(err?.message).toBe('Authentication failed');
		// A wrong org credential is just another rejected secret → it MUST be
		// counted (before this fix the auth path recorded nothing).
		expect(await liveRedis.get(authKey('9.9.9.9'))).toBe('1');
	});

	it('throttles AUTH once the per-IP failure budget is exhausted', async () => {
		// Burn the budget (3 failures) — each is a normal "Authentication failed".
		for (let i = 0; i < 3; i++) {
			const { err } = await authCallIp({ username: 'x', password: 'nope' }, '5.5.5.5', liveRedis);
			expect(err?.message).toBe('Authentication failed');
		}
		// The 4th attempt is refused by the throttle BEFORE comparing the secret —
		// even the correct master key is rejected while locked out.
		const { err, user } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'5.5.5.5',
			liveRedis,
		);
		expect(user).toBeUndefined();
		expect(err?.message).toMatch(/Too many failed authentication attempts/);
	});

	it('clears the failure counter after a successful auth', async () => {
		await authCallIp({ username: 'x', password: 'nope' }, '7.7.7.7', liveRedis);
		expect(await liveRedis.get(authKey('7.7.7.7'))).toBe('1');
		const { err, user } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'7.7.7.7',
			liveRedis,
		);
		expect(err).toBeNull();
		expect(user).toBe('master');
		expect(await liveRedis.get(authKey('7.7.7.7'))).toBeNull();
	});

	it('tracks failures per IP independently', async () => {
		for (let i = 0; i < 3; i++) {
			await authCallIp({ username: 'x', password: 'nope' }, '1.1.1.1', liveRedis);
		}
		// A different IP is still allowed to attempt (and succeed).
		const { err, user } = await authCallIp(
			{ username: 'x', password: 'master-secret-key' },
			'2.2.2.2',
			liveRedis,
		);
		expect(err).toBeNull();
		expect(user).toBe('master');
	});
});

describe('createSubmissionServer — TLS guard + connection limiting', () => {
	const queue = { add: vi.fn() } as unknown as Queue<EmailJob>;

	// SMTPServer validates the PEM at construction (tls.createSecureContext), so
	// the happy-path tests need real TLS material. Generate a throwaway
	// self-signed pair once.
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-submission-test-'));
		try {
			execFileSync('openssl', [
				'req', '-x509', '-newkey', 'rsa:2048',
				'-keyout', join(dir, 'key.pem'),
				'-out', join(dir, 'cert.pem'),
				'-days', '1', '-nodes', '-subj', '/CN=mta.test',
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
			createSubmissionServer(queue, redis, tlsConfig({ submissionTlsCert: undefined })),
		).toThrow(/SUBMISSION_TLS_CERT/);
	});

	it('THROWS when the TLS key is undefined', () => {
		expect(() =>
			createSubmissionServer(queue, redis, tlsConfig({ submissionTlsKey: undefined })),
		).toThrow(/SUBMISSION_TLS_KEY/);
	});

	it('THROWS when both cert and key are undefined', () => {
		expect(() =>
			createSubmissionServer(
				queue,
				redis,
				tlsConfig({ submissionTlsCert: undefined, submissionTlsKey: undefined }),
			),
		).toThrow(/Refusing to start an insecure submission listener/);
	});

	it('is constructed with maxClients set from config', () => {
		const server = createSubmissionServer(queue, redis, tlsConfig());
		expect((server.options as { maxClients?: number }).maxClients).toBe(200);
	});

	it('installs an onConnect per-IP limiter that rejects the N+1th connection', async () => {
		const liveRedis = new Redis() as unknown as RealRedis;
		const server = createSubmissionServer(
			queue,
			liveRedis,
			tlsConfig({ submissionMaxConnectionsPerIp: 3 }),
		);
		const onConnect = (server as unknown as {
			onConnect: (s: object, cb: (err?: Error | null) => void) => void;
		}).onConnect;
		expect(typeof onConnect).toBe('function');

		const connect = (ip: string) =>
			new Promise<Error | null | undefined>((resolve) => {
				onConnect({ remoteAddress: ip }, (err) => resolve(err));
			});

		// First 3 from the same IP are allowed…
		expect(await connect('8.8.8.8')).toBeFalsy();
		expect(await connect('8.8.8.8')).toBeFalsy();
		expect(await connect('8.8.8.8')).toBeFalsy();
		// …the 4th is rejected by the per-IP cap.
		const fourth = await connect('8.8.8.8');
		expect(fourth).toBeInstanceOf(Error);
		expect(fourth?.message).toMatch(/Too many connections/);
		// A different IP is unaffected.
		expect(await connect('8.8.4.4')).toBeFalsy();
	});
});

// ── Wire-level TLS gate tests (PR-54) ──────────────────────────────────────
//
// (1) Regression-lock the (smtp-server-provided) STARTTLS-before-AUTH gate on
//     the 587 listener: an AUTH issued before STARTTLS MUST be refused with a
//     530/538 and must never reach our onAuth (RFC 3207 / RFC 4954 §4 / RFC 8314
//     §3.3). After STARTTLS the master key authenticates (235).
// (2) Lock the implicit-TLS (465) listener: it is encrypted from the first byte
//     (RFC 8314 §3.3/§7.3 preferred), serves its 220 banner + AUTH over TLS, and
//     a plaintext client cannot complete the handshake.
describe('submission TLS gate — wire-level (PR-54)', () => {
	const queue = { add: vi.fn() } as unknown as Queue<EmailJob>;
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-submission-tls-test-'));
		try {
			execFileSync('openssl', [
				'req', '-x509', '-newkey', 'rsa:2048',
				'-keyout', join(dir, 'key.pem'),
				'-out', join(dir, 'cert.pem'),
				'-days', '1', '-nodes', '-subj', '/CN=mta.test',
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

	// Boot a server on an ephemeral port (uses ioredis-mock for the limiter).
	function boot(server: SMTPServer): Promise<number> {
		return new Promise((resolve, reject) => {
			server.on('error', reject);
			server.listen(0, '127.0.0.1', () => {
				resolve((server.server.address() as AddressInfo).port);
			});
		});
	}

	function closeServer(server: SMTPServer): Promise<void> {
		return new Promise((resolve) => server.close(() => resolve()));
	}

	type Conn = net.Socket | tls.TLSSocket;

	/** Read until a complete SMTP reply arrives (final line is `NNN<space>`). */
	function readReply(conn: Conn): Promise<string> {
		return new Promise((resolve, reject) => {
			let buf = '';
			const onData = (chunk: Buffer) => {
				buf += chunk.toString('utf8');
				// A multi-line reply uses `NNN-...`; the terminal line is `NNN ...`.
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
		Buffer.from(` ${user} ${pass}`, 'utf8').toString('base64');

	it('587: refuses AUTH before STARTTLS (530/538) without invoking onAuth, then authenticates after STARTTLS', async () => {
		const server = createSubmissionServer(queue, new Redis() as unknown as RealRedis, tlsConfig());
		// Spy on the bound handler smtp-server actually invokes (this._server.onAuth).
		const onAuthSpy = vi.fn(server.onAuth.bind(server));
		(server as unknown as { onAuth: typeof server.onAuth }).onAuth = onAuthSpy;

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

			// AUTH PLAIN with the correct master key — but BEFORE STARTTLS. The
			// library must refuse it (530 "Must issue a STARTTLS command first";
			// some versions use 538) and our onAuth must never run.
			send(sock, `AUTH PLAIN ${plainAuth('master', 'master-secret-key')}`);
			const preAuthReply = await readReply(sock);
			expect(preAuthReply).toMatch(/^(530|538) /);
			expect(preAuthReply).toMatch(/Must issue a STARTTLS command first/i);
			expect(onAuthSpy).not.toHaveBeenCalled();

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
			expect(onAuthSpy).toHaveBeenCalledTimes(1);

			secure.destroy();
		} finally {
			await closeServer(server);
		}
	});

	it('465: implicit TLS serves the 220 banner + AUTH over the encrypted channel', async () => {
		const server = createImplicitTlsSubmissionServer(
			queue,
			new Redis() as unknown as RealRedis,
			tlsConfig(),
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
			await closeServer(server);
		}
	});

	it('465: a plaintext client cannot complete the implicit-TLS handshake', async () => {
		const server = createImplicitTlsSubmissionServer(
			queue,
			new Redis() as unknown as RealRedis,
			tlsConfig(),
		);
		const port = await boot(server);
		try {
			// Plaintext connect: the server speaks TLS from the first byte, so it
			// never emits a 220 SMTP banner. A plaintext EHLO is interpreted as a
			// malformed ClientHello and the connection is torn down — no greeting.
			const result = await new Promise<'no-banner' | 'banner'>((resolve, reject) => {
				const sock = net.connect(port, '127.0.0.1');
				let sawBanner = false;
				const timer = setTimeout(() => {
					sock.destroy();
					resolve(sawBanner ? 'banner' : 'no-banner');
				}, 500);
				sock.on('connect', () => send(sock, 'EHLO client.test'));
				sock.on('data', (chunk: Buffer) => {
					if (/^220 /.test(chunk.toString('utf8'))) sawBanner = true;
				});
				// A handshake-rejection error / EOF is the expected outcome.
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
			await closeServer(server);
		}
	});
});
