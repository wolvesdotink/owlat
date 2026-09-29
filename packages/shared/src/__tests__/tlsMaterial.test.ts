import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTlsMaterial, type TlsMaterialOptions } from '../tlsMaterial';

const CERT = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'owlat-tls-material-'));
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

function load(
	env: Record<string, string | undefined>,
	overrides: Partial<TlsMaterialOptions> = {}
): ReturnType<typeof loadTlsMaterial> {
	return loadTlsMaterial({
		env,
		inlineCert: 'X_TLS_CERT',
		inlineKey: 'X_TLS_KEY',
		certFile: 'X_TLS_CERT_FILE',
		keyFile: 'X_TLS_KEY_FILE',
		certDir: dir,
		label: 'Test',
		...overrides,
	});
}

describe('loadTlsMaterial', () => {
	it('returns null when nothing is configured and the directory is empty', () => {
		expect(load({})).toBeNull();
		expect(load({}, { certDir: undefined })).toBeNull();
	});

	it('uses an inline pair first, without reload paths', () => {
		writePair();
		const files = writePair('explicit');
		expect(
			load({
				X_TLS_CERT: 'inline-cert',
				X_TLS_KEY: 'inline-key',
				X_TLS_CERT_FILE: files.cert,
				X_TLS_KEY_FILE: files.key,
			})
		).toEqual({ cert: 'inline-cert', key: 'inline-key' });
	});

	it('treats an empty variable as unset', () => {
		const files = writePair();
		expect(load({ X_TLS_CERT: '', X_TLS_KEY_FILE: '' })).toEqual({
			cert: CERT,
			key: KEY,
			paths: files,
		});
	});

	it.each([
		[{ X_TLS_CERT: 'c' }, /Test TLS is half configured: X_TLS_CERT is set but X_TLS_KEY is not/],
		[{ X_TLS_KEY: 'k' }, /X_TLS_KEY is set but X_TLS_CERT is not/],
		[{ X_TLS_CERT_FILE: '/c.crt' }, /X_TLS_CERT_FILE is set but X_TLS_KEY_FILE is not/],
		[{ X_TLS_KEY_FILE: '/c.key' }, /X_TLS_KEY_FILE is set but X_TLS_CERT_FILE is not/],
	])('fails on half a pair %j, even with a complete directory pair', (env, message) => {
		writePair();
		expect(() => load(env)).toThrowError(message);
	});

	it('reads an explicit file pair ahead of the directory and reports its paths', () => {
		writeFileSync(join(dir, 'default.crt'), 'dir-cert');
		writeFileSync(join(dir, 'default.key'), 'dir-key');
		const files = writePair('explicit');
		expect(load({ X_TLS_CERT_FILE: files.cert, X_TLS_KEY_FILE: files.key })).toEqual({
			cert: CERT,
			key: KEY,
			paths: files,
		});
	});

	it('fails when an explicitly configured file is missing, instead of falling back', () => {
		const files = writePair();
		let caught: unknown;
		try {
			load({ X_TLS_CERT_FILE: join(dir, 'typo.crt'), X_TLS_KEY_FILE: files.key });
		} catch (err) {
			caught = err;
		}
		expect((caught as Error).message).toMatch(
			/Cannot read Test TLS material at .*typo\.crt \(X_TLS_CERT_FILE\): ENOENT/
		);
		expect((caught as Error).cause).toMatchObject({ code: 'ENOENT' });
	});

	it('falls back to default.{crt,key} in the cert directory', () => {
		const files = writePair();
		expect(load({})).toEqual({ cert: CERT, key: KEY, paths: files });
	});

	it('ignores a directory that holds only half a pair', () => {
		writeFileSync(join(dir, 'default.crt'), CERT);
		expect(load({})).toBeNull();
	});

	// Root ignores permission bits, so this only holds for an unprivileged user,
	// which is how the imap and mta containers run.
	it.skipIf(process.getuid?.() === 0)(
		'explains an unreadable file with the uid, the ownership fix and the hint',
		() => {
			const { key } = writePair();
			chmodSync(key, 0o000);
			let caught: unknown;
			try {
				load({}, { ownershipHint: 'The volume is read-only.' });
			} catch (err) {
				caught = err;
			}
			const message = (caught as Error).message;
			expect(message).toContain(`Cannot read Test TLS material at ${key} (TLS_CERT_DIR)`);
			expect(message).toContain(`permission denied for uid ${process.getuid?.()}`);
			expect(message).toContain('imap-cert-init chowns to IMAP_RUNTIME_USER');
			expect(message).toMatch(/The volume is read-only\.$/);
			expect((caught as Error).cause).toMatchObject({ code: 'EACCES' });
			chmodSync(key, 0o600);
		}
	);
});
