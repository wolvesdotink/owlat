import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	startTlsCertReloader,
	type TlsCertMaterial,
	type TlsCertReloader,
	type TlsCertReloaderOptions,
} from '../tlsCertReloader';

/** A throwaway self-signed pair, generated the way the smtp-listener suites do. */
function generatePair(cn: string): TlsCertMaterial {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-cert-reload-gen-'));
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

let oldPair: TlsCertMaterial;
let newPair: TlsCertMaterial;

beforeAll(() => {
	oldPair = generatePair('old.mail.example.com');
	newPair = generatePair('new.mail.example.com');
}, 30000);

describe('startTlsCertReloader', () => {
	let dir: string;
	let certPath: string;
	let keyPath: string;
	let reloader: TlsCertReloader | undefined;
	const info = vi.fn();
	const warn = vi.fn();
	const apply = vi.fn();

	function write(material: TlsCertMaterial): void {
		writeFileSync(certPath, material.cert);
		writeFileSync(keyPath, material.key);
	}

	function start(overrides: Partial<TlsCertReloaderOptions> = {}): TlsCertReloader {
		reloader = startTlsCertReloader({
			certPath,
			keyPath,
			initial: oldPair,
			apply,
			log: { info, warn },
			...overrides,
		});
		return reloader;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'owlat-cert-reload-'));
		certPath = join(dir, 'default.crt');
		keyPath = join(dir, 'default.key');
		write(oldPair);
		info.mockReset();
		warn.mockReset();
		apply.mockReset();
	});

	afterEach(() => {
		reloader?.stop();
		reloader = undefined;
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it('does nothing while the files hold the pair already in service', async () => {
		const r = start();
		expect(await r.check()).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('installs a renewed pair and logs its subject and expiry once', async () => {
		const r = start();
		write(newPair);

		expect(await r.check()).toBe(true);
		expect(apply).toHaveBeenCalledOnce();
		expect(apply).toHaveBeenCalledWith(newPair);
		expect(r.current()).toEqual(newPair);
		expect(info).toHaveBeenCalledOnce();
		const [message, detail] = info.mock.calls[0]!;
		expect(message).toBe('TLS certificate reloaded');
		expect(detail).toMatchObject({ certPath, subject: 'CN=new.mail.example.com' });
		expect(Date.parse(detail.notAfter)).toBeGreaterThan(Date.now());

		// Nothing changed since: no second swap.
		expect(await r.check()).toBe(false);
		expect(apply).toHaveBeenCalledOnce();
	});

	it('keeps the current pair when the key does not match the certificate, and warns once', async () => {
		const r = start();
		// A half-published renewal: new cert, old key.
		write({ cert: newPair.cert, key: oldPair.key });

		expect(await r.check()).toBe(false);
		expect(await r.check()).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(r.current()).toEqual(oldPair);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toMatch(/invalid; keeping the current certificate/);

		// The publisher finishes: the complete pair goes in.
		write(newPair);
		expect(await r.check()).toBe(true);
		expect(r.current()).toEqual(newPair);
	});

	it('keeps the current pair when a file holds garbage', async () => {
		const r = start();
		write({ cert: 'not a certificate', key: newPair.key });

		expect(await r.check()).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
	});

	it('keeps the current pair when the consumer rejects the new one', async () => {
		apply.mockImplementation(() => {
			throw new Error('refused');
		});
		const r = start();
		write(newPair);

		expect(await r.check()).toBe(false);
		expect(r.current()).toEqual(oldPair);
		expect(info).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![1]).toMatchObject({ error: 'refused' });
	});

	it('keeps the current pair when the files cannot be read, and warns once per cause', async () => {
		const r = start();
		rmSync(keyPath);

		expect(await r.check()).toBe(false);
		expect(await r.check()).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toMatch(/cannot read the files/);
		expect(r.current()).toEqual(oldPair);
	});

	it('polls on the interval and stops polling after stop()', async () => {
		vi.useFakeTimers();
		const files = new Map<string, string>([
			[certPath, oldPair.cert],
			[keyPath, oldPair.key],
		]);
		const readFile = vi.fn(async (path: string) => files.get(path) ?? '');
		const r = start({ intervalMs: 1_000, readFile });

		await vi.advanceTimersByTimeAsync(999);
		expect(readFile).not.toHaveBeenCalled();

		files.set(certPath, newPair.cert);
		files.set(keyPath, newPair.key);
		await vi.advanceTimersByTimeAsync(1);
		expect(apply).toHaveBeenCalledWith(newPair);

		r.stop();
		const reads = readFile.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(readFile.mock.calls.length).toBe(reads);
	});
});
