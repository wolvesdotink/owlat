import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmtpListener } from '@owlat/smtp-listener';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectSmtpTlsCertificate } from '../../routes/health.js';
import { startBounceTlsReload, type BounceTlsReload } from '../tlsReload.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../monitoring/logger.js');

function generatePair(cn: string): { cert: string; key: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-mta-reload-gen-'));
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
				'30',
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

const HOST = 'mail.example.com';
let oldPair: { cert: string; key: string };
let newPair: { cert: string; key: string };

beforeAll(() => {
	// The boot certificate does not cover the EHLO name; the renewed one does, so
	// /health's verdict tells the two apart.
	oldPair = generatePair('old.example.com');
	newPair = generatePair(HOST);
}, 30000);

describe('startBounceTlsReload', () => {
	let dir: string;
	let paths: { cert: string; key: string };
	let reload: BounceTlsReload | undefined;
	const updateTlsMaterial = vi.fn();
	const listener = { updateTlsMaterial } as unknown as SmtpListener;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'owlat-mta-reload-'));
		paths = { cert: join(dir, 'default.crt'), key: join(dir, 'default.key') };
		writeFileSync(paths.cert, oldPair.cert);
		writeFileSync(paths.key, oldPair.key);
		updateTlsMaterial.mockReset();
		vi.mocked(logger.info).mockClear();
		vi.mocked(logger.warn).mockClear();
	});

	afterEach(() => {
		reload?.stop();
		reload = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const config = () => ({
		bounceServerTlsCert: oldPair.cert,
		bounceServerTlsKey: oldPair.key,
		bounceServerTlsPaths: paths,
	});

	it('swaps a renewed pair into the listener and /health reports the new certificate', async () => {
		reload = startBounceTlsReload(config(), () => listener);
		expect(inspectSmtpTlsCertificate(reload.currentCert(), HOST)).toMatchObject({
			status: 'fail',
			reason: 'hostname-mismatch',
		});

		writeFileSync(paths.cert, newPair.cert);
		writeFileSync(paths.key, newPair.key);

		expect(await reload.check()).toBe(true);
		expect(updateTlsMaterial).toHaveBeenCalledWith(newPair);
		expect(inspectSmtpTlsCertificate(reload.currentCert(), HOST)).toMatchObject({
			status: 'pass',
		});
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ subject: `CN=${HOST}` }),
			'Inbound SMTP: TLS certificate reloaded'
		);
	});

	it('keeps reporting the old certificate when the listener refuses the new pair', async () => {
		updateTlsMaterial.mockImplementation(() => {
			throw new Error('bad pair');
		});
		reload = startBounceTlsReload(config(), () => listener);
		writeFileSync(paths.cert, newPair.cert);
		writeFileSync(paths.key, newPair.key);

		expect(await reload.check()).toBe(false);
		expect(reload.currentCert()).toBe(oldPair.cert);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('does not watch inline PEM', async () => {
		reload = startBounceTlsReload(
			{ bounceServerTlsCert: oldPair.cert, bounceServerTlsKey: oldPair.key },
			() => listener
		);
		writeFileSync(paths.cert, newPair.cert);
		writeFileSync(paths.key, newPair.key);

		expect(await reload.check()).toBe(false);
		expect(reload.currentCert()).toBe(oldPair.cert);
		expect(updateTlsMaterial).not.toHaveBeenCalled();
	});
});
