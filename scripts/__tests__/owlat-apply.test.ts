/**
 * `owlat apply` is the command every "change .env, then …" hint points at, so
 * it has to do what `owlat restart` never did (issue #839):
 *   - run `docker compose up -d` with the install's COMPOSE_PROFILES, so a
 *     container whose resolved env changed is recreated and a newly enabled
 *     profile service is started;
 *   - stop a service whose profile was disabled;
 *   - push the Convex function-runtime keys through the setup image.
 *
 * These cases run the REAL `scripts/owlat` against a stub `docker` that records
 * each call (with the COMPOSE_PROFILES / COMPOSE_PROJECT_NAME it saw) and
 * answers the few queries the wrapper makes from environment variables.
 */

import { execFile } from 'node:child_process';
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { getFlagOwnedProfiles } from '@owlat/shared/featureFlags';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

// Answers, in order of specificity:
//   compose config --services  → $STUB_ACTIVE (the enabled services)
//   compose --profile … config --services
//                              → $STUB_FLAG_SERVICES (what the flag-owned
//                                profiles declare, plus unprofiled services)
//   compose config             → a rendered config naming the project
//   ps … --format …            → $STUB_RUNNING (services with a container)
//   ps -aq … service=<name>    → a fake container id
//   run … --help               → $STUB_SETUP_HELP (default: a help text listing
//                                push-env and unset-env), exit $STUB_HELP_EXIT
//   run … push-env             → exit $STUB_PUSH_EXIT
//   run … unset-env …          → exit $STUB_UNSET_EXIT
const STUB_DOCKER = `#!/bin/sh
printf '%s | profiles=%s project=%s\\n' "$*" "\${COMPOSE_PROFILES-<unset>}" "\${COMPOSE_PROJECT_NAME-<unset>}" >> "$STUB_LOG"
case "$*" in
	"compose config --services") printf '%s\\n' $STUB_ACTIVE ;;
	compose\\ --profile*config\\ --services) printf '%s\\n' $STUB_FLAG_SERVICES; exit "\${STUB_FLAG_QUERY_EXIT:-0}" ;;
	"compose config") printf 'name: owlat-test\\nservices: {}\\n' ;;
	ps\\ --filter*--format*) printf '%s\\n' $STUB_RUNNING ;;
	ps\\ -aq*) printf 'id-%s\\n' "\${*##*service=}" ;;
	run\\ *--help)
		printf '%s\\n' "\${STUB_SETUP_HELP-  push-env           Push the Convex function-runtime keys
  unset-env <KEY> [KEY...]}"
		exit "\${STUB_HELP_EXIT:-0}" ;;
	run\\ *push-env) exit "\${STUB_PUSH_EXIT:-0}" ;;
	run\\ *unset-env*) exit "\${STUB_UNSET_EXIT:-0}" ;;
esac
exit 0
`;

interface Install {
	readonly dir: string;
	readonly log: string;
	readonly invoke: (
		args: string[],
		env?: Record<string, string>
	) => Promise<{ code: number; stdout: string; stderr: string }>;
	readonly calls: () => Promise<string[]>;
}

async function makeInstall(files: { env?: string; override?: string } = {}): Promise<Install> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-apply-')));
	roots.push(root);
	const dir = join(root, 'owlat');
	const stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, 'scripts/owlat'), join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	if (files.env !== undefined) await writeFile(join(dir, '.env'), files.env);
	if (files.override !== undefined) {
		await writeFile(join(dir, 'docker-compose.override.yml'), files.override);
	}
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
	const log = join(root, 'docker-calls.log');

	return {
		dir,
		log,
		async invoke(args, env = {}) {
			const base = { ...process.env };
			delete base['COMPOSE_PROFILES'];
			delete base['COMPOSE_PROJECT_NAME'];
			try {
				const { stdout, stderr } = await run('bash', [join(dir, 'scripts', 'owlat'), ...args], {
					env: {
						...base,
						PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
						OWLAT_DIR: dir,
						OWLAT_SKIP_CLI_LINK: '1',
						OWLAT_SETUP_IMAGE: 'setup-image:test',
						STUB_LOG: log,
						STUB_ACTIVE: '',
						STUB_FLAG_SERVICES: '',
						STUB_RUNNING: '',
						...env,
					},
				});
				return { code: 0, stdout, stderr };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					code: failure.code ?? 1,
					stdout: failure.stdout ?? '',
					stderr: failure.stderr ?? '',
				};
			}
		},
		async calls() {
			return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
		},
	};
}

// What the shared renderer writes (packages/shared/src/composeOverride.ts).
const BLOCK_OVERRIDE = [
	'# Generated by Owlat. DO NOT EDIT MANUALLY.',
	'# Active profiles: clamav, mta',
	'',
	'x-owlat-profiles:',
	'  - clamav',
	'  - mta',
	'x-owlat-generated-at: "2026-09-28T00:00:00.000Z"',
	'services:',
	'  __clamav_marker:',
	'    image: busybox:stable',
	'',
].join('\n');

describe('owlat apply', () => {
	it('runs compose up -d with the union of .env and override profiles', async () => {
		const install = await makeInstall({
			env: 'COMPOSE_PROFILES="mta,tls"\n',
			override: BLOCK_OVERRIDE,
		});

		const result = await install.invoke(['apply']);

		expect(result.code).toBe(0);
		const up = (await install.calls()).find((line) => line.startsWith('compose up -d'));
		expect(up).toBe('compose up -d | profiles=clamav,mta,tls project=<unset>');
	});

	it('reads an inline [a, b] override list too', async () => {
		const install = await makeInstall({ override: 'x-owlat-profiles: [ai, mta]\nservices: {}\n' });

		await install.invoke(['apply']);

		const up = (await install.calls()).find((line) => line.startsWith('compose up -d'));
		expect(up).toContain('profiles=ai,mta ');
	});

	it('stops a service whose profile is no longer enabled, and nothing else', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		await install.invoke(['apply'], {
			STUB_ACTIVE: 'web convex mta',
			STUB_FLAG_SERVICES: 'web convex mta clamav',
			STUB_RUNNING: 'web convex mta clamav',
		});

		const calls = await install.calls();
		expect(calls.filter((line) => line.startsWith('stop '))).toEqual([
			expect.stringMatching(/^stop id-clamav /),
		]);
		expect(calls.filter((line) => line.startsWith('rm '))).toEqual([
			expect.stringMatching(/^rm id-clamav /),
		]);
		expect(calls.some((line) => line.includes('label=com.docker.compose.project=owlat-test'))).toBe(
			true
		);
	});

	it('leaves a service started under a manual profile running', async () => {
		// docker-compose.yml tells operators to start the Convex dashboard by
		// hand; no flag says it should run, so it is never in the active set.
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		await install.invoke(['apply'], {
			STUB_ACTIVE: 'web convex mta',
			STUB_FLAG_SERVICES: 'web convex mta clamav',
			STUB_RUNNING: 'web convex mta clamav convex-dashboard',
		});

		const calls = await install.calls();
		expect(calls.filter((line) => /^(stop|rm) /.test(line))).toEqual([
			expect.stringMatching(/^stop id-clamav /),
			expect.stringMatching(/^rm id-clamav /),
		]);
		// The flag-owned set is asked for with every flag-owned profile named,
		// which replaces COMPOSE_PROFILES for that one call.
		const flagQuery = calls.find((line) => line.startsWith('compose --profile'));
		for (const profile of getFlagOwnedProfiles()) {
			expect(flagQuery).toContain(`--profile ${profile} `);
		}
	});

	it('prunes nothing when compose cannot say which services the flags own', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['apply'], {
			STUB_ACTIVE: 'web convex mta',
			STUB_FLAG_SERVICES: '',
			STUB_RUNNING: 'web convex mta clamav convex-dashboard',
			STUB_FLAG_QUERY_EXIT: '1',
		});

		expect(result.code).toBe(0);
		expect((await install.calls()).some((line) => /^(stop|rm) /.test(line))).toBe(false);
	});

	it('names exactly the profiles the flag registry owns', async () => {
		const script = await readFile(join(REPOSITORY_ROOT, 'scripts/owlat'), 'utf8');
		const declared = /^FLAG_OWNED_PROFILES=\(([^)]*)\)$/m.exec(script)?.[1];

		expect(declared?.trim().split(/\s+/).sort()).toEqual([...getFlagOwnedProfiles()].sort());
	});

	it('pushes the Convex runtime keys through the setup image, in this project', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['apply']);

		expect(result.code).toBe(0);
		const push = (await install.calls()).find(
			(line) => line.startsWith('run ') && line.includes('push-env')
		);
		expect(push).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
		expect(push).toContain('-e COMPOSE_PROJECT_NAME=owlat-test');
		expect(push).toContain('setup-image:test push-env');
	});

	it('fails loudly when the runtime-key push fails', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['apply'], { STUB_PUSH_EXIT: '3' });

		expect(result.code).toBe(3);
		expect(result.stderr).toContain('were NOT pushed');
	});

	it('says to upgrade, instead of running push-env, when the setup image predates it', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		// What a pre-apply setup image lists: every command but push-env.
		const result = await install.invoke(['apply'], {
			STUB_SETUP_HELP: '  env <KEY> <VALUE>  Set a single environment variable.\n  doctor',
		});

		expect(result.code).toBe(1);
		const calls = await install.calls();
		expect(calls.some((line) => line.startsWith('compose up -d'))).toBe(true);
		expect(calls.some((line) => line.includes('push-env'))).toBe(false);
		expect(result.stderr).toContain('were NOT pushed');
		expect(result.stderr).toContain("setup image (setup-image:test) predates 'owlat apply'");
		expect(result.stderr).toContain("'owlat upgrade'");
		expect(result.stdout + result.stderr).not.toContain('Unknown command');
	});

	it('still runs push-env when the setup image cannot be probed', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['apply'], { STUB_SETUP_HELP: '', STUB_HELP_EXIT: '125' });

		expect(result.code).toBe(0);
		const calls = await install.calls();
		expect(calls.some((line) => line.includes('setup-image:test push-env'))).toBe(true);
	});

	it('scopes a named-service run: no profile clean-up, no push', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['apply', 'mta'], {
			STUB_ACTIVE: 'web mta',
			STUB_RUNNING: 'web mta clamav',
		});

		expect(result.code).toBe(0);
		const calls = await install.calls();
		expect(calls).toEqual(['compose up -d mta | profiles=mta project=<unset>']);
		expect(result.stdout).toContain("run 'owlat apply' without a service name");
	});
});

describe('owlat unset-env', () => {
	it('runs unset-env through the setup image, with the socket, in this project', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['unset-env', 'LLM_BASE_URL', 'DECISION_MODEL']);

		expect(result.code).toBe(0);
		const calls = await install.calls();
		const unset = calls.find((line) => line.startsWith('run ') && line.includes('unset-env'));
		expect(unset).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
		expect(unset).toContain('-e COMPOSE_PROJECT_NAME=owlat-test');
		expect(unset).toContain('setup-image:test unset-env LLM_BASE_URL DECISION_MODEL');
		// Clearing a key neither recreates containers nor pushes the rest.
		expect(calls.some((line) => line.startsWith('compose up'))).toBe(false);
		expect(calls.some((line) => line.includes('push-env'))).toBe(false);
	});

	it("passes the setup CLI's failure through", async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['unset-env', 'LLM_BASE_URL'], { STUB_UNSET_EXIT: '1' });

		expect(result.code).toBe(1);
	});

	it('says to upgrade, instead of running unset-env, when the setup image predates it', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		const result = await install.invoke(['unset-env', 'LLM_BASE_URL'], {
			STUB_SETUP_HELP: '  push-env           Push the Convex function-runtime keys',
		});

		expect(result.code).toBe(1);
		expect((await install.calls()).some((line) => line.includes('unset-env'))).toBe(false);
		expect(result.stderr).toContain('Nothing was changed');
		expect(result.stderr).toContain("predates 'owlat unset-env'");
	});
});

describe('owlat start', () => {
	it('activates every profile in a multi-line override (not just the key name)', async () => {
		const install = await makeInstall({ override: BLOCK_OVERRIDE });

		await install.invoke(['start']);

		expect(await install.calls()).toEqual(['compose up -d | profiles=clamav,mta project=<unset>']);
	});

	it('leaves COMPOSE_PROFILES to compose when neither file names profiles', async () => {
		const install = await makeInstall({ env: 'SITE_URL=https://owlat.example.com\n' });

		await install.invoke(['start']);

		expect(await install.calls()).toEqual(['compose up -d | profiles=<unset> project=<unset>']);
	});
});

describe('owlat restart', () => {
	it('stays a plain process restart', async () => {
		const install = await makeInstall({ env: 'COMPOSE_PROFILES=mta\n' });

		await install.invoke(['restart', 'mta']);

		expect(await install.calls()).toEqual([
			'compose restart mta | profiles=<unset> project=<unset>',
		]);
	});

	it('says in --help that it does not apply .env changes', async () => {
		const install = await makeInstall();

		const result = await install.invoke(['--help']);

		expect(result.stdout).toMatch(/owlat restart .*\n.*does NOT pick up \.env changes/);
		expect(result.stdout).toContain('owlat apply [service...]');
		expect(result.stdout).toContain('owlat --help');
	});
});
