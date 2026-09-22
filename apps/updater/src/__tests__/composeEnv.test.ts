import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

/**
 * THE UPDATER MUST NOT TELL COMPOSE WHAT VERSION IT IS.
 *
 * Compose resolves `${VAR}` from the CLI's own environment BEFORE it reads
 * `--env-file`. The updater is a service in the compose file it is applying
 * (`OWLAT_VERSION: ${OWLAT_VERSION:-dev}`), so it carries the version it was
 * created at — the one being replaced — and passes it back to compose, where it
 * shadows the `.env` the rollout pinned one step earlier.
 *
 * Release templates pin their images literally, so the stack still comes up on
 * the new release and nothing looks wrong: only the interpolated values go
 * stale. A real 0.5.2 → 0.5.3 rollout left `web`, `mta` and `updater` running
 * 0.5.3 images reporting `OWLAT_VERSION=0.5.2`, while `imap` and `mail-sync`,
 * which override nothing, were correct. On a locally built service the
 * interpolation IS the image tag, so the rollout points it at the old release.
 */

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const OWLAT_DIR = mkdtempSync(join(tmpdir(), 'owlat-compose-env-test-'));
process.env['OWLAT_DIR'] = OWLAT_DIR;
process.env['INSTANCE_SECRET'] = 'test-instance-secret-0123456789';
writeFileSync(join(OWLAT_DIR, 'docker-compose.yml'), 'services: {}\n');

const { exec, COMPOSE_SHADOWED_VARS } = await import('../http.js');
const { scheduleUpdaterRecreateSafely } = await import('../rollout.js');

/** `docker inspect <self>` as rollout.ts formats it: image, binds, networks. */
const SELF_INSPECT = `ghcr.io/wolvesdotink/updater:0.5.2\n/opt/owlat:${OWLAT_DIR}:rw \ndefault docker-proxy \n`;

beforeEach(() => {
	execFileSyncMock.mockReset().mockImplementation((_file: string, args: string[]) => {
		if (args[0] === 'inspect' && args[1] === hostname()) return SELF_INSPECT;
		return 'helper-container-id\n';
	});
	// The stale values the updater is born with, exactly as compose sets them.
	process.env['OWLAT_VERSION'] = '0.5.2';
	process.env['OWLAT_GIT_SHA'] = 'aaaaaaa';
	process.env['OWLAT_BUILD_DATE'] = '2026-09-20T00:00:00Z';
	process.env['DOCKER_HOST'] = 'tcp://docker-socket-proxy:2375';
});

describe('exec', () => {
	it('hands compose an environment with nothing that can shadow --env-file', () => {
		exec('docker', ['compose', 'up', '-d'], OWLAT_DIR);

		const options = execFileSyncMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
		for (const name of COMPOSE_SHADOWED_VARS) {
			expect(options.env[name], `${name} must not reach compose`).toBeUndefined();
		}
	});

	it('leaves the rest of the environment alone — Docker is reached through it', () => {
		exec('docker', ['compose', 'up', '-d'], OWLAT_DIR);

		const options = execFileSyncMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
		expect(options.env['DOCKER_HOST']).toBe('tcp://docker-socket-proxy:2375');
		expect(options.env['OWLAT_DIR']).toBe(OWLAT_DIR);
	});

	it('does not disturb the updater’s own environment', () => {
		exec('docker', ['compose', 'up', '-d'], OWLAT_DIR);

		expect(process.env['OWLAT_VERSION']).toBe('0.5.2');
	});
});

describe('scheduleUpdaterRecreateSafely', () => {
	/**
	 * The helper is a separate container running the updater's OWN image, so it
	 * inherits the stale version from the image rather than from this process —
	 * `exec`'s scrubbing cannot reach it, and without the `unset` the updater's
	 * replacement comes up reporting the release it was meant to leave behind.
	 */
	it('unsets the shadowing variables inside the helper container', () => {
		const step = scheduleUpdaterRecreateSafely(1);
		expect(step.ok).toBe(true);

		const runArgs = execFileSyncMock.mock.calls
			.map((call) => call[1] as string[])
			.find((args) => args[0] === 'run');
		const command = runArgs?.[runArgs.length - 1] ?? '';

		expect(command).toContain(`unset ${COMPOSE_SHADOWED_VARS.join(' ')};`);
		// Before the compose command, not after it.
		expect(command.indexOf('unset')).toBeLessThan(command.indexOf('docker compose'));
		expect(command).toContain('up -d --no-deps updater');
	});
});
