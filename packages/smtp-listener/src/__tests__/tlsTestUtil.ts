/**
 * Shared harness for the listener integration tests: a runtime-generated
 * self-signed cert (via `openssl`, mirroring the MTA's bannerEhlo test), a tiny
 * line-buffering SMTP client that can drive a plaintext socket, upgrade it to
 * TLS in place (STARTTLS), or connect over implicit TLS, and a listener
 * start/stop helper shared by every suite.
 *
 * This is a helper module, not a test file (no `*.test.ts` suffix), so vitest's
 * `include` glob skips it.
 *
 * The client itself lives in `../smtpTestClient.ts` and is re-exported here so
 * this package's suites keep importing `Client` from one place. It moved out
 * because `apps/mta`'s MX suites need the SAME client and had forked an older,
 * flakier copy; that file's header documents the two properties (consuming
 * `waitCode`, event-driven waits) that copy was missing.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmtpListener, type SmtpListener } from '../server.js';
import type { SmtpListenerOptions } from '../types.js';

export { Client } from '../smtpTestClient.js';

/** Generate a throwaway self-signed RSA cert/key pair for a loopback listener. */
export function generateCert(cn = 'mx.test'): { cert: string; key: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-smtp-l2-'));
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
			`/CN=${cn}`,
		]);
		return {
			cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
			key: readFileSync(join(dir, 'key.pem'), 'utf8'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Base64-encode a SASL AUTH PLAIN token: `authzid NUL authcid NUL passwd`. */
export function plainToken(username: string, password: string, authzid = ''): string {
	return Buffer.from(`${authzid}\0${username}\0${password}`, 'utf8').toString('base64');
}

/** Base64-encode a single SASL LOGIN field. */
export function b64(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Listener harness shared by every suite (one live-listener registry per test
// file — vitest isolates modules per file, so the registry never leaks across
// suites). Each suite registers `afterEach(closeAllListeners)`.
// ---------------------------------------------------------------------------

const activeListeners: SmtpListener[] = [];

/** Start a listener on an ephemeral loopback port and return its bound port. */
export async function startListener(
	opts: SmtpListenerOptions
): Promise<{ listener: SmtpListener; port: number }> {
	const listener = createSmtpListener(opts);
	activeListeners.push(listener);
	await listener.listen(0, '127.0.0.1');
	const addr = listener.address();
	if (!addr || typeof addr === 'string') throw new Error('no address');
	return { listener, port: addr.port };
}

/** Close every listener started in this file (idempotent). */
export async function closeAllListeners(): Promise<void> {
	while (activeListeners.length > 0) {
		const l = activeListeners.pop();
		try {
			await l?.close();
		} catch {
			/* already closed */
		}
	}
}
