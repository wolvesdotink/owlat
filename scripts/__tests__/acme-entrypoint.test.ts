/**
 * The VPS `acme` sidecar republishes the mail TLS pair into a volume that the
 * IMAP server and the MTA's inbound SMTP listener poll for changes
 * (packages/shared/src/tlsCertReloader.ts). A reader must never see a
 * half-written file, a key still owned by root, or a cert without its key, so
 * every file is staged beside its destination with its final mode and owner
 * and then renamed into place, key before cert.
 *
 * These cases run the REAL infra/templates/acme-entrypoint.sh under `sh` with
 * stub `lego`, `chown`, `mv` and `sleep` on PATH. `chown` and `mv` log what
 * they were asked to do; `mv` then performs the real rename. `sleep` fails, so
 * the script leaves its renewal loop after the first publish.
 */

import { execFile } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const SCRIPT = fileURLToPath(new URL('../../infra/templates/acme-entrypoint.sh', import.meta.url));
const VPS_COMPOSE = fileURLToPath(
	new URL('../../infra/templates/docker-compose.vps.yml', import.meta.url)
);
const DOMAIN = 'mail.example.test';
const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function stub(dir: string, name: string, body: string) {
	await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
	await chmod(join(dir, name), 0o755);
}

async function makeSidecar(options: { chownExit?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'owlat-acme-'));
	roots.push(root);
	const certDir = join(root, 'certs');
	const legoPath = join(root, 'lego');
	const stubDir = join(root, 'stub-bin');
	const log = join(root, 'calls.log');
	await mkdir(join(legoPath, 'certificates'), { recursive: true });
	await mkdir(certDir, { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await writeFile(join(legoPath, 'certificates', `${DOMAIN}.crt`), 'NEW CERT\n');
	await writeFile(join(legoPath, 'certificates', `${DOMAIN}.key`), 'NEW KEY\n');

	const realMv = (await run('sh', ['-c', 'command -v mv'])).stdout.trim();
	await stub(stubDir, 'lego', 'exit 0');
	await stub(stubDir, 'sleep', 'exit 1');
	await stub(stubDir, 'chown', `echo "chown $*" >> "$STUB_LOG"\nexit ${options.chownExit ?? 0}`);
	await stub(stubDir, 'mv', `echo "mv $*" >> "$STUB_LOG"\nexec ${realMv} "$@"`);

	const env = {
		TLS_CERT_DIR: certDir,
		LEGO_PATH: legoPath,
		ACME_DOMAIN: DOMAIN,
		// The renewal-attempt marker goes under TMPDIR; keep it in the sandbox.
		TMPDIR: root,
	};

	return {
		certDir,
		marker: join(root, 'owlat-acme-attempt'),
		/** Exit status of the VPS template's acme healthcheck against this sandbox. */
		async healthcheck() {
			const service = (
				parse(await readFile(VPS_COMPOSE, 'utf8')) as {
					services: { acme: { healthcheck: { test: string[] } } };
				}
			).services.acme;
			const [kind, command] = service.healthcheck.test;
			expect(kind).toBe('CMD-SHELL');
			return run('sh', ['-c', command!.replaceAll('$$', '$')], {
				env: { PATH: process.env['PATH'] ?? '', ...env },
			}).then(
				() => 0,
				(error: { code?: number }) => error.code ?? 1
			);
		},
		async publish() {
			// The stub `sleep` ends the renewal loop with a non-zero exit.
			await run('sh', [SCRIPT], {
				env: {
					PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
					...env,
					ACME_CONTACT_EMAIL: 'ops@owlat.example',
					LEGO_PROVIDER: 'hetzner',
					IMAP_RUNTIME_USER: '1000:1000',
					STUB_LOG: log,
				},
			}).catch(() => undefined);
			return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
		},
	};
}

describe('acme-entrypoint.sh publish', () => {
	it('stages each file with its owner, then renames the key before the cert', async () => {
		const sidecar = await makeSidecar();

		const calls = await sidecar.publish();

		const renames = calls.filter((line) => line.startsWith('mv '));
		expect(renames.map((line) => line.split(' ').at(-1))).toEqual([
			join(sidecar.certDir, 'default.key'),
			join(sidecar.certDir, 'default.crt'),
			join(sidecar.certDir, `${DOMAIN}.key`),
			join(sidecar.certDir, `${DOMAIN}.crt`),
		]);
		// Every rename moves a staged file that was already handed to the runtime
		// user, so the live name never points at a root-owned key.
		for (const rename of renames) {
			const staged = rename.split(' ').at(-2)!;
			expect(staged).toMatch(/\/\.[^/]+\.tmp\.\d+$/);
			const chownAt = calls.indexOf(`chown 1000:1000 ${staged}`);
			expect(chownAt).toBeGreaterThanOrEqual(0);
			expect(chownAt).toBeLessThan(calls.indexOf(rename));
		}

		expect(await readFile(join(sidecar.certDir, 'default.key'), 'utf8')).toBe('NEW KEY\n');
		expect(await readFile(join(sidecar.certDir, 'default.crt'), 'utf8')).toBe('NEW CERT\n');
		expect((await stat(join(sidecar.certDir, 'default.key'))).mode & 0o777).toBe(0o600);
		expect((await stat(join(sidecar.certDir, 'default.crt'))).mode & 0o777).toBe(0o644);
		expect((await stat(join(sidecar.certDir, `${DOMAIN}.key`))).mode & 0o777).toBe(0o600);
		expect((await readdir(sidecar.certDir)).sort()).toEqual(
			['default.crt', 'default.key', `${DOMAIN}.crt`, `${DOMAIN}.key`].sort()
		);
	});

	it('leaves the published pair untouched and no staged files behind when staging fails', async () => {
		const sidecar = await makeSidecar({ chownExit: 1 });
		await writeFile(join(sidecar.certDir, 'default.crt'), 'OLD CERT\n');
		await writeFile(join(sidecar.certDir, 'default.key'), 'OLD KEY\n');

		const calls = await sidecar.publish();

		expect(calls.some((line) => line.startsWith('mv '))).toBe(false);
		expect(await readFile(join(sidecar.certDir, 'default.crt'), 'utf8')).toBe('OLD CERT\n');
		expect(await readFile(join(sidecar.certDir, 'default.key'), 'utf8')).toBe('OLD KEY\n');
		expect((await readdir(sidecar.certDir)).sort()).toEqual(['default.crt', 'default.key']);
	});
});

describe('acme healthcheck (docker-compose.vps.yml)', () => {
	it('passes once the loop has published what lego holds', async () => {
		const sidecar = await makeSidecar();
		await sidecar.publish();

		expect(await sidecar.healthcheck()).toBe(0);
	});

	it('fails before the first attempt has finished', async () => {
		const sidecar = await makeSidecar();

		expect(await sidecar.healthcheck()).not.toBe(0);
	});

	it('fails when the published certificate is not the one lego holds', async () => {
		const sidecar = await makeSidecar({ chownExit: 1 });
		await writeFile(join(sidecar.certDir, 'default.crt'), 'OLD CERT\n');
		await writeFile(join(sidecar.certDir, 'default.key'), 'OLD KEY\n');
		await sidecar.publish();

		expect(await sidecar.healthcheck()).not.toBe(0);
	});

	it('fails once the renewal loop has not come round for a whole interval', async () => {
		const sidecar = await makeSidecar();
		await sidecar.publish();
		const dayAndTwoHoursAgo = Date.now() / 1000 - 26 * 3600;
		await utimes(sidecar.marker, dayAndTwoHoursAgo, dayAndTwoHoursAgo);

		expect(await sidecar.healthcheck()).not.toBe(0);
	});
});
