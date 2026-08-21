import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../gen-release-compose.sh');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

// A minimal compose fixture covering every tag form the script rewrites, plus
// an upstream image and a local-only image that must both stay untouched.
const COMPOSE_FIXTURE = `services:
  web:
    image: ghcr.io/wolvesdotink/web:\${OWLAT_VERSION:-dev}
  mta:
    image: ghcr.io/wolvesdotink/mta:\${OWLAT_VERSION}
  updater:
    image: ghcr.io/wolvesdotink/updater:latest
  redis:
    image: redis:\${REDIS_VERSION:-7.4-alpine}
  code-worker:
    image: owlat-code-worker:\${OWLAT_VERSION:-dev}
`;

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
		return { status: 0, stdout, stderr: '' };
	} catch (err) {
		const e = err as { status: number | null; stdout?: string; stderr?: string };
		return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
	}
}

describe('gen-release-compose.sh', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'owlat-gen-compose-'));
		writeFileSync(join(root, 'docker-compose.yml'), COMPOSE_FIXTURE);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('rewrites every Owlat tag form to the release version, leaving other images alone', () => {
		const result = run(root, ['1.2.3', 'out.yml']);
		expect(result.status).toBe(0);

		const output = readFileSync(join(root, 'out.yml'), 'utf8');
		expect(output).toContain('image: ghcr.io/wolvesdotink/web:1.2.3');
		expect(output).toContain('image: ghcr.io/wolvesdotink/mta:1.2.3');
		expect(output).toContain('image: ghcr.io/wolvesdotink/updater:1.2.3');
		expect(output).toContain('image: redis:${REDIS_VERSION:-7.4-alpine}');
		expect(output).toContain('image: owlat-code-worker:${OWLAT_VERSION:-dev}');
	});

	it('pins each Owlat image to tag@digest when a digests file is supplied', () => {
		writeFileSync(
			join(root, 'digests.txt'),
			// Extra entries for images the template does not reference are fine.
			`web ${DIGEST_A}\nmta ${DIGEST_B}\nupdater ${DIGEST_A}\nsetup ${DIGEST_B}\n`
		);
		const result = run(root, ['1.2.3', 'out.yml', 'digests.txt']);
		expect(result.status).toBe(0);

		const output = readFileSync(join(root, 'out.yml'), 'utf8');
		expect(output).toContain(`image: ghcr.io/wolvesdotink/web:1.2.3@${DIGEST_A}`);
		expect(output).toContain(`image: ghcr.io/wolvesdotink/mta:1.2.3@${DIGEST_B}`);
		expect(output).toContain(`image: ghcr.io/wolvesdotink/updater:1.2.3@${DIGEST_A}`);
		// Upstream and local-only images stay tag-pinned (no digest).
		expect(output).toContain('image: redis:${REDIS_VERSION:-7.4-alpine}');
		expect(output).not.toContain('redis@sha256');
		expect(output).toContain('image: owlat-code-worker:${OWLAT_VERSION:-dev}');
	});

	it('fails when an Owlat image in the template has no digest entry', () => {
		writeFileSync(join(root, 'digests.txt'), `web ${DIGEST_A}\nmta ${DIGEST_B}\n`);
		const result = run(root, ['1.2.3', 'out.yml', 'digests.txt']);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('without a digest pin');
		expect(result.stderr).toContain('ghcr.io/wolvesdotink/updater:1.2.3');
	});

	it('fails on a malformed digests line', () => {
		writeFileSync(join(root, 'digests.txt'), 'web not-a-digest\n');
		const result = run(root, ['1.2.3', 'out.yml', 'digests.txt']);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('malformed digests line');
	});

	it('rejects a non-semver version', () => {
		const result = run(root, ['main', 'out.yml']);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('not valid semver');
	});
});
