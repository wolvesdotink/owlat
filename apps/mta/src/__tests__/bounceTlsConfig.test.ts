import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBounceTlsMaterial } from '../bounceTlsConfig.js';

const CERT = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

describe('loadBounceTlsMaterial', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'mta-tls-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writePair(prefix = 'default'): { cert: string; key: string } {
		const cert = join(dir, `${prefix}.crt`);
		const key = join(dir, `${prefix}.key`);
		writeFileSync(cert, CERT);
		writeFileSync(key, KEY);
		return { cert, key };
	}

	it('returns nothing when no source is configured', () => {
		expect(loadBounceTlsMaterial({})).toEqual({});
	});

	it('reads default.{crt,key} from the shared mail-certs directory', () => {
		const files = writePair();
		expect(loadBounceTlsMaterial({ TLS_CERT_DIR: dir })).toEqual({
			cert: CERT,
			key: KEY,
			paths: files,
		});
	});

	it('watches a cert directory that does not hold a complete pair yet', () => {
		writeFileSync(join(dir, 'default.crt'), CERT);
		const loaded = loadBounceTlsMaterial({ TLS_CERT_DIR: dir });
		expect(loaded).toEqual({
			paths: { cert: join(dir, 'default.crt'), key: join(dir, 'default.key') },
			unavailable: expect.stringMatching(/do not exist yet/),
		});
		expect(loaded.cert).toBeUndefined();
	});

	it('watches an empty cert directory so a certificate published later is picked up', () => {
		expect(loadBounceTlsMaterial({ TLS_CERT_DIR: dir })).toMatchObject({
			paths: { cert: join(dir, 'default.crt'), key: join(dir, 'default.key') },
		});
	});

	it('prefers inline PEM over files and the cert directory, as a whole pair', () => {
		const files = writePair('explicit');
		writePair();
		expect(
			loadBounceTlsMaterial({
				BOUNCE_TLS_CERT: 'inline-cert',
				BOUNCE_TLS_KEY: 'inline-key',
				BOUNCE_TLS_CERT_FILE: files.cert,
				BOUNCE_TLS_KEY_FILE: files.key,
				TLS_CERT_DIR: dir,
			})
		).toEqual({ cert: 'inline-cert', key: 'inline-key' });
		// A half-configured inline pair never borrows its other half from disk.
		expect(loadBounceTlsMaterial({ BOUNCE_TLS_CERT: 'inline-cert', TLS_CERT_DIR: dir })).toEqual({
			cert: 'inline-cert',
		});
	});

	it('prefers explicit file paths over the cert directory', () => {
		const files = writePair('explicit');
		writeFileSync(join(dir, 'default.crt'), 'dir-cert');
		writeFileSync(join(dir, 'default.key'), 'dir-key');
		expect(
			loadBounceTlsMaterial({
				BOUNCE_TLS_CERT_FILE: files.cert,
				BOUNCE_TLS_KEY_FILE: files.key,
				TLS_CERT_DIR: dir,
			})
		).toEqual({ cert: CERT, key: KEY, paths: files });
	});

	it('reports no reload paths for a half-configured file pair', () => {
		const files = writePair('explicit');
		expect(loadBounceTlsMaterial({ BOUNCE_TLS_CERT_FILE: files.cert })).toEqual({ cert: CERT });
	});

	it('fails loudly when an explicitly configured file is missing', () => {
		expect(() => loadBounceTlsMaterial({ BOUNCE_TLS_CERT_FILE: join(dir, 'nope.crt') })).toThrow(
			/BOUNCE_TLS_CERT_FILE.*ENOENT/
		);
	});

	it.skipIf(process.getuid?.() === 0)('names the ownership fix when the key is unreadable', () => {
		const { key } = writePair();
		chmodSync(key, 0o000);
		expect(() => loadBounceTlsMaterial({ TLS_CERT_DIR: dir })).toThrow(/permission denied/);
	});
});
