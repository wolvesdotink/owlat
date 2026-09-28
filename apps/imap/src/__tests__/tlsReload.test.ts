/**
 * A renewed certificate on disk reaches the next IMAPS handshake: a real
 * `tls.Server`, real files, a real client reading the presented certificate.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Server, type TlsOptions } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TlsCertReloader } from '@owlat/shared/tlsCertReloader';
import { startImapTlsReload } from '../tlsReload.js';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function generatePair(cn: string): { cert: string; key: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-imap-reload-gen-'));
	try {
		execFileSync(
			'openssl',
			[
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
				`/CN=${cn}`,
			],
			{ stdio: 'ignore' }
		);
		return {
			cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
			key: readFileSync(join(dir, 'key.pem'), 'utf8'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const POLICY: TlsOptions = { minVersion: 'TLSv1.2', honorCipherOrder: true };

/** Handshake with the server and return the CN it presented. */
function presentedCn(port: number): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const socket = connect(
			// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
			{ port, host: '127.0.0.1', rejectUnauthorized: false },
			() => {
				const cn = socket.getPeerCertificate().subject?.CN;
				socket.destroy();
				resolve(Array.isArray(cn) ? cn[0] : cn);
			}
		);
		socket.once('error', reject);
	});
}

let oldPair: { cert: string; key: string };
let newPair: { cert: string; key: string };

beforeAll(() => {
	oldPair = generatePair('old.imap.example.com');
	newPair = generatePair('new.imap.example.com');
}, 30000);

describe('startImapTlsReload', () => {
	let dir: string;
	let paths: { cert: string; key: string };
	let server: Server;
	let port: number;
	let reloader: TlsCertReloader | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'owlat-imap-reload-'));
		paths = { cert: join(dir, 'default.crt'), key: join(dir, 'default.key') };
		writeFileSync(paths.cert, oldPair.cert);
		writeFileSync(paths.key, oldPair.key);
		server = createServer({ ...POLICY, ...oldPair }, (socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		reloader?.stop();
		reloader = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	it('serves the renewed certificate to the next handshake', async () => {
		reloader = startImapTlsReload(server, { ...oldPair, paths }, POLICY);
		expect(await presentedCn(port)).toBe('old.imap.example.com');

		writeFileSync(paths.cert, newPair.cert);
		writeFileSync(paths.key, newPair.key);
		expect(await reloader!.check()).toBe(true);

		expect(await presentedCn(port)).toBe('new.imap.example.com');
	});

	it('keeps serving the current certificate when the renewed pair is broken', async () => {
		reloader = startImapTlsReload(server, { ...oldPair, paths }, POLICY);
		writeFileSync(paths.cert, newPair.cert);

		expect(await reloader!.check()).toBe(false);
		expect(await presentedCn(port)).toBe('old.imap.example.com');
	});

	it('does not watch inline PEM', () => {
		expect(startImapTlsReload(server, oldPair, POLICY)).toBeUndefined();
	});
});
