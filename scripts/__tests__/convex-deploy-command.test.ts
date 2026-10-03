/**
 * The convex-deploy image is the one step every update path runs (the in-app
 * updater, `owlat upgrade`, the manual path in the maintenance docs). Its
 * command deploys the functions and then sets OWLAT_VERSION on the deployment,
 * because Convex functions read the version from the deployment's environment
 * and only setup ever wrote it (issue #1147).
 *
 * These cases run the REAL docker/convex-deploy.sh under `sh` with a stub
 * `convex` on PATH that logs each call and exits with the code the case asks
 * for.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../docker/convex-deploy.sh', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../../docker/convex-deploy.Dockerfile', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface RunOptions {
	version?: string;
	deployExit?: number;
	envSetExit?: number;
}

async function runDeploy(options: RunOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), 'owlat-convex-deploy-'));
	roots.push(root);
	const stubDir = join(root, 'stub-bin');
	const log = join(root, 'calls.log');
	await mkdir(stubDir, { recursive: true });
	await writeFile(
		join(stubDir, 'convex'),
		[
			'#!/bin/sh',
			'echo "$*" >> "$STUB_LOG"',
			'case "$1" in',
			'  deploy) exit "$DEPLOY_EXIT" ;;',
			'  env) exit "$ENV_SET_EXIT" ;;',
			'esac',
			'exit 64',
		].join('\n') + '\n'
	);
	await chmod(join(stubDir, 'convex'), 0o755);

	const env: Record<string, string> = {
		PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
		CONVEX_SELF_HOSTED_URL: 'http://convex:3210',
		CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|0123456789abcdef',
		DEPLOY_EXIT: String(options.deployExit ?? 0),
		ENV_SET_EXIT: String(options.envSetExit ?? 0),
		STUB_LOG: log,
	};
	if (options.version !== undefined) env['OWLAT_VERSION'] = options.version;

	const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile('sh', [SCRIPT], { env }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
			resolve({ code, stdout, stderr });
		});
	});
	const calls = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
	return { ...result, calls };
}

const DEPLOY_CALL =
	'deploy --url http://convex:3210 --admin-key convex-self-hosted|0123456789abcdef';

describe('docker/convex-deploy.sh', () => {
	it('deploys the functions, then sets OWLAT_VERSION on the deployment to the image version', async () => {
		const run = await runDeploy({ version: '0.6.9' });

		expect(run.code).toBe(0);
		expect(run.calls).toEqual([DEPLOY_CALL, 'env set -- OWLAT_VERSION 0.6.9']);
		expect(run.stdout).toContain('OWLAT_VERSION set to 0.6.9 on the deployment');
	});

	it('never claims the new version when the deploy fails, and fails with its exit code', async () => {
		const run = await runDeploy({ version: '0.6.9', deployExit: 3 });

		expect(run.code).toBe(3);
		expect(run.calls).toEqual([DEPLOY_CALL]);
	});

	it('still succeeds when only setting the version fails, and says how to retry', async () => {
		const run = await runDeploy({ version: '0.6.9', envSetExit: 1 });

		expect(run.code).toBe(0);
		expect(run.calls).toEqual([DEPLOY_CALL, 'env set -- OWLAT_VERSION 0.6.9']);
		expect(run.stderr).toContain('setting OWLAT_VERSION=0.6.9 on the deployment failed');
		expect(run.stderr).toContain('docker compose --profile deploy run --rm convex-deploy');
	});

	it('leaves the deployment version alone when the image carries none', async () => {
		const run = await runDeploy({ version: '' });

		expect(run.code).toBe(0);
		expect(run.calls).toEqual([DEPLOY_CALL]);
		expect(run.stderr).toContain('carries no OWLAT_VERSION');
	});
});

describe('docker/convex-deploy.Dockerfile', () => {
	const dockerfile = readFileSync(DOCKERFILE, 'utf8');
	const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

	it('runs the script as the image command', () => {
		expect(finalStage).toContain(
			'COPY --chmod=755 docker/convex-deploy.sh /usr/local/bin/owlat-convex-deploy'
		);
		const cmds = finalStage.split('\n').filter((line) => line.startsWith('CMD '));
		expect(cmds).toEqual(['CMD ["owlat-convex-deploy"]']);
	});

	it('bakes the release version into the environment the script reads', () => {
		expect(finalStage).toMatch(/^ARG OWLAT_VERSION=/m);
		expect(finalStage).toMatch(/^ENV OWLAT_VERSION=\$\{OWLAT_VERSION\}/m);
	});
});
