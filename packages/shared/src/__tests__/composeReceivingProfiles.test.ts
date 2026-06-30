import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards the docker-compose wiring that keeps the opt-in receiving profiles
 * (external-mail / personal-mail) bootable. No `docker compose config` harness
 * runs in CI, so these are string assertions against the checked-in compose
 * file — they fail if the crash-loop regressions ever creep back:
 *
 *   • external-mail: MAIL_SYNC_API_KEY must NOT carry an empty `:-` default
 *     (an empty value makes apps/mail-sync/src/config.ts throw on boot).
 *   • personal-mail: the IMAP TLS cert must be provisioned, because
 *     apps/imap/src/server.ts refuses to start in production without one.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');

describe('docker-compose.yml — external-mail profile', () => {
	it('passes MAIL_SYNC_API_KEY through without an empty default', () => {
		// The required form (no `:-` fallback) — matches MTA_API_KEY. An empty
		// default would silently turn a missing key into a mail-sync crash-loop.
		expect(compose).toMatch(/MAIL_SYNC_API_KEY:\s*\$\{MAIL_SYNC_API_KEY\}/);
		expect(compose).not.toMatch(/MAIL_SYNC_API_KEY:\s*\$\{MAIL_SYNC_API_KEY:-\}/);
	});

	it('runs the mail-sync worker under the external-mail profile', () => {
		expect(compose).toMatch(/mail-sync:/);
		expect(compose).toMatch(/-\s*external-mail/);
	});
});

describe('docker-compose.yml — personal-mail profile', () => {
	it('provisions a default IMAP TLS cert before the imap server starts', () => {
		// A cert-init service that self-signs default.crt/default.key into the
		// shared mail-certs volume.
		expect(compose).toMatch(/imap-cert-init:/);
		expect(compose).toMatch(/default\.crt/);
		expect(compose).toMatch(/default\.key/);
		expect(compose).toMatch(/openssl req -x509/);
	});

	it('blocks the imap server on the cert-init completing successfully', () => {
		// The dependency is what stops the IMAPS listener from coming up before a
		// cert exists (apps/imap/src/server.ts throws otherwise in production).
		const imapBlock = compose.slice(compose.indexOf('\n  imap:\n'));
		expect(imapBlock).toMatch(/imap-cert-init:\s*\n\s*condition:\s*service_completed_successfully/);
	});

	it('keeps cert-init under the personal-mail profile', () => {
		const initBlock = compose.slice(
			compose.indexOf('imap-cert-init:'),
			compose.indexOf('\n  imap:\n'),
		);
		expect(initBlock).toMatch(/-\s*personal-mail/);
	});
});
