/**
 * The update flow (scripts/e2e-update-flow.sh) gates publication, so what it
 * accepts decides whether a release ships. Its run needs Docker and two real
 * releases and only happens in the Update flow workflow; these cases pin the
 * parts that decide its verdict, running the REAL functions under bash:
 *
 *   - where TO's template comes from: a draft's, handed over as files, is
 *     never swapped for an anonymous download, and neither is accepted
 *     without its checksum;
 *   - what an answer from the updater has to say for each scenario to pass;
 *   - the rollback scenario's template, which changes web's healthcheck and
 *     nothing else, and the barrier that says the release is on trial;
 *   - the data check after a rollback, which compares against FROM.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-update-flow-lib-'));
	roots.push(root);
	return root;
}

/**
 * Runs `<script>` under bash after sourcing the update flow's libraries, in
 * `cwd`, with `FROM=1.2.0 TO=1.3.0` and the given environment.
 */
function runLib(script: string, env: Record<string, string> = {}, cwd = tmpdir()) {
	const source = ['lib', 'data', 'rollback']
		.map((name) => `source "${join(SCRIPTS, `e2e-update-flow-${name}.sh`)}"`)
		.join('; ');
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			'bash',
			['-c', `set -euo pipefail; FROM=1.2.0; TO=1.3.0; ${source}; ${script}`],
			{ cwd, env: { ...process.env, REPO: 'example/owlat', ...env } },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ code, stdout, stderr });
			}
		);
	});
}

/** A release's template and its checksum file in `dir`. */
async function release(dir: string, version: string, tamper = false) {
	await mkdir(dir, { recursive: true });
	const name = `docker-compose-${version}.yml`;
	const body = `services:\n  web:\n    image: ghcr.io/wolvesdotink/web:${version}\n`;
	await writeFile(join(dir, name), body);
	const digest = createHash('sha256')
		.update(tamper ? `${body}#` : body)
		.digest('hex');
	await writeFile(join(dir, `${name}.sha256`), `${digest}  ${name}\n`);
	return body;
}

/**
 * A stand-in for curl serving the published releases in $PUBLISHED. Like
 * GitHub, it answers only `releases/download/v<version>/` URLs of published
 * releases: a draft has no anonymous URL. Every URL asked for goes to $CALLS.
 */
const CURL = `
curl() {
	local out='' url=''
	while (($#)); do
		case "$1" in
		-o) out="$2"; shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
		esac
	done
	echo "$url" >>"$CALLS"
	local file="$PUBLISHED/\${url##*/}"
	[[ "$url" == https://github.com/example/owlat/releases/download/v*/* && -f "$file" ]] || return 22
	cp "$file" "$out"
}`;

describe('fetch_template', () => {
	async function setup() {
		const root = await scratch();
		const env = {
			PUBLISHED: join(root, 'published'),
			CALLS: join(root, 'calls'),
			OUT: join(root, 'out'),
			DRAFT: join(root, 'draft'),
		};
		await mkdir(env.PUBLISHED);
		await writeFile(env.CALLS, '');
		const calls = async () => (await readFile(env.CALLS, 'utf8')).split('\n').filter(Boolean);
		return { env, calls };
	}

	it('downloads a published release anonymously and checks its checksum', async () => {
		const { env, calls } = await setup();
		const body = await release(env.PUBLISHED, '1.2.0');
		const { code } = await runLib(`${CURL}; fetch_template 1.2.0 "$OUT"`, env);
		expect(code).toBe(0);
		expect(await readFile(join(env.OUT, 'docker-compose-1.2.0.yml'), 'utf8')).toBe(body);
		expect(await calls()).toEqual([
			'https://github.com/example/owlat/releases/download/v1.2.0/docker-compose-1.2.0.yml',
			'https://github.com/example/owlat/releases/download/v1.2.0/docker-compose-1.2.0.yml.sha256',
		]);
	});

	it('fails a draft target asked for by its version: a draft has no anonymous URL', async () => {
		const { env } = await setup();
		await release(env.DRAFT, '1.3.0');
		const { code, stderr } = await runLib(`${CURL}; fetch_template 1.3.0 "$OUT"`, env);
		expect(code).toBe(1);
		expect(stderr).toContain(
			'cannot download https://github.com/example/owlat/releases/download/v1.3.0/docker-compose-1.3.0.yml'
		);
	});

	it('takes a draft target from the files handed over, without downloading anything', async () => {
		const { env, calls } = await setup();
		const body = await release(env.DRAFT, '1.3.0');
		const { code } = await runLib(`${CURL}; fetch_template 1.3.0 "$OUT" "$DRAFT"`, env);
		expect(code).toBe(0);
		expect(await readFile(join(env.OUT, 'docker-compose-1.3.0.yml'), 'utf8')).toBe(body);
		expect(await calls()).toEqual([]);
	});

	it('fails a handed-over target that is missing, rather than downloading the published one', async () => {
		const { env, calls } = await setup();
		await release(env.PUBLISHED, '1.3.0');
		await mkdir(env.DRAFT);
		const { code, stderr } = await runLib(`${CURL}; fetch_template 1.3.0 "$OUT" "$DRAFT"`, env);
		expect(code).toBe(1);
		expect(stderr).toContain('docker-compose-1.3.0.yml or its checksum is missing');
		expect(await calls()).toEqual([]);
	});

	it.each([
		['handed over', true],
		['downloaded', false],
	])('rejects a %s template that does not match its checksum', async (_, local) => {
		const { env } = await setup();
		await release(local ? env.DRAFT : env.PUBLISHED, '1.3.0', true);
		const { code, stderr } = await runLib(
			`${CURL}; fetch_template 1.3.0 "$OUT" ${local ? '"$DRAFT"' : ''}`,
			env
		);
		expect(code).toBe(1);
		expect(stderr).toContain('checksum mismatch for docker-compose-1.3.0.yml');
	});
});

describe('untestable', () => {
	it('warns and passes outside a gate, and fails under STRICT=1', async () => {
		const lenient = await runLib('untestable "no updater"; echo after', { STRICT: '0' });
		expect(lenient).toMatchObject({ code: 0, stdout: '::warning::no updater\n' });
		const strict = await runLib('untestable "no updater"; echo after', { STRICT: '1' });
		expect(strict.code).toBe(1);
		expect(strict.stdout).toBe('');
		expect(strict.stderr).toContain('no updater (STRICT=1: an untested update must not pass)');
	});
});

type StepRow = { step: string; ok?: boolean; stdout?: string; stderr?: string };

/** The answer the updater gives for a release that failed readiness and was rolled back. */
function rolledBack(): Record<string, unknown> & { steps: StepRow[] } {
	return {
		error: 'The release did not pass the readiness check. The update was rolled back',
		rollout: 'rolled-back',
		warnings: [],
		steps: [
			{ step: 'docker-api', ok: true, stdout: 'ok' },
			{ step: 'pull', ok: true, stdout: '' },
			{ step: 'snapshot', ok: true, stdout: 'Snapshot 1729 taken of owlat_convex-data (1 GiB)' },
			{ step: 'convex-deploy', ok: true, stdout: 'deployed' },
			{ step: 'write-compose', stdout: 'Compose file updated' },
			{ step: 'pin-version', ok: true, stdout: 'OWLAT_VERSION pinned to 1.3.0' },
			{ step: 'up', ok: true, stdout: '' },
			{
				step: 'readiness',
				ok: false,
				stderr: 'Not ready after 190s: web (failing its healthcheck).',
			},
			{ step: 'rollback-restore', ok: true, stdout: 'Restored owlat_convex-data' },
			{ step: 'rollback-up', ok: true, stdout: '' },
			{ step: 'rollback-readiness', ok: true, stdout: 'All 4 services are up' },
		],
	};
}

describe('update_verdict', () => {
	async function verdict(scenario: string, answer: unknown, status: number) {
		const root = await scratch();
		const file = join(root, 'response.json');
		await writeFile(file, typeof answer === 'string' ? answer : JSON.stringify(answer));
		const { code, stdout } = await runLib(`update_verdict ${scenario} "$ANSWER" ${status}`, {
			ANSWER: file,
		});
		expect(code).toBe(0);
		return stdout.split('\n').filter(Boolean);
	}
	const success = { success: true, rollout: 'healthy', steps: [{ step: 'up', ok: true }] };

	it('accepts a successful update only as HTTP 200 with success and no failed step', async () => {
		expect(await verdict('success', success, 200)).toEqual([]);
		expect(await verdict('success', success, 500)).toEqual(['HTTP 500, not 200']);
		expect(
			await verdict(
				'success',
				{ ...success, steps: [...success.steps, { step: 'reclaim-images', ok: false }] },
				200
			)
		).toEqual(['steps failed: reclaim-images']);
		expect(await verdict('success', { ...success, success: false }, 200)).toEqual([
			'success is false, not true',
		]);
	});

	it('accepts a release that failed readiness and was rolled back', async () => {
		expect(await verdict('rollback', rolledBack(), 500)).toEqual([]);
	});

	it('rejects an update that succeeded, or answered anything but rolled-back', async () => {
		expect(await verdict('rollback', success, 200)).toEqual(
			expect.arrayContaining([
				'HTTP 200, not 500',
				'rollout is "healthy", not "rolled-back"',
				'the answer claims success',
			])
		);
		for (const rollout of ['failed', 'started', 'partially-applied'])
			expect(await verdict('rollback', { ...rolledBack(), rollout }, 500)).toEqual([
				`rollout is "${rollout}", not "rolled-back"`,
			]);
	});

	it.each([
		['the deploy', 'convex-deploy', 'convex-deploy failed: refused'],
		['the recreate', 'up', 'up failed: refused'],
	])('rejects a rollback caused by %s rather than by readiness', async (_, step, problem) => {
		const answer = rolledBack();
		answer.steps = answer.steps
			.map((row) => (row.step === step ? { ...row, ok: false, stderr: 'refused' } : row))
			.filter((row) => row.step !== 'readiness');
		expect(await verdict('rollback', answer, 500)).toEqual(
			expect.arrayContaining([problem, 'the release never reached the readiness check'])
		);
	});

	it('rejects a rollback without a snapshot, a failed restore or an unready restored release', async () => {
		const without = (step: string) => ({
			...rolledBack(),
			steps: rolledBack().steps.filter((row) => row.step !== step),
		});
		expect(await verdict('rollback', without('snapshot'), 500)).toEqual(
			expect.arrayContaining(['no snapshot was taken'])
		);
		expect(await verdict('rollback', without('rollback-restore'), 500)).toEqual([
			'nothing was restored',
		]);
		const unready = rolledBack();
		unready.steps.at(-1)!.ok = false;
		unready.steps.at(-1)!.stderr = 'Not ready after 60s: web.';
		expect(await verdict('rollback', unready, 500)).toEqual([
			'the restored release is not ready: Not ready after 60s: web.',
		]);
		const passed = rolledBack();
		passed.steps.find((row) => row.step === 'readiness')!.ok = true;
		expect(await verdict('rollback', passed, 500)).toEqual([
			'the release passed the readiness check it was built to fail',
		]);
	});

	it('rejects an answer that is not a JSON object', async () => {
		expect(await verdict('rollback', 'Bad Gateway', 502)).toEqual([
			"the updater's answer is not a JSON object",
		]);
	});
});

describe('failing_web_template', () => {
	async function failing(source: string) {
		const root = await scratch();
		const input = join(root, 'in.yml');
		await writeFile(input, source);
		const result = await runLib('failing_web_template "$IN" "$OUT"', {
			IN: input,
			OUT: join(root, 'out.yml'),
		});
		return { ...result, output: () => readFile(join(root, 'out.yml'), 'utf8') };
	}
	type Compose = { services: Record<string, { healthcheck?: Record<string, unknown> }> };

	it("replaces web's healthcheck in the shipped template, and nothing else", async () => {
		const source = await readFile(COMPOSE, 'utf8');
		const result = await failing(source);
		expect(result.code).toBe(0);
		const before = parse(source) as Compose;
		const after = parse(await result.output()) as Compose;
		expect(after.services['web']!.healthcheck).toEqual({
			test: ['CMD', 'node', '-e', 'process.exit(1)'],
			interval: '5s',
			timeout: '3s',
			retries: 1,
		});
		delete before.services['web']!.healthcheck;
		delete after.services['web']!.healthcheck;
		expect(after).toEqual(before);
	});

	it('adds the failing healthcheck to a web service that declares none', async () => {
		const source =
			'services:\n  web:\n    logging: *x\n    image: ghcr.io/wolvesdotink/web:1.3.0\n    read_only: true\n  redis:\n    healthcheck:\n      test: [CMD, "true"]\n';
		const result = await failing(source.replace('*x', 'json'));
		expect(result.code).toBe(0);
		const after = parse(await result.output()) as Compose;
		expect(after.services['web']).toEqual({
			logging: 'json',
			image: 'ghcr.io/wolvesdotink/web:1.3.0',
			healthcheck: {
				test: ['CMD', 'node', '-e', 'process.exit(1)'],
				interval: '5s',
				timeout: '3s',
				retries: 1,
			},
			read_only: true,
		});
		expect(after.services['redis']!.healthcheck).toEqual({ test: ['CMD', 'true'] });
	});

	it('refuses a template without a web service', async () => {
		const result = await failing(
			'services:\n  redis:\n    healthcheck:\n      test: [CMD, "true"]\n'
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('has no single web service to make fail');
	});
});

describe('on_trial', () => {
	async function trial(journal: unknown, record: unknown) {
		const root = await scratch();
		await mkdir(join(root, '.owlat-update-snapshot'));
		await writeFile(join(root, '.owlat-update-snapshot/snapshot.json'), JSON.stringify(journal));
		await writeFile(join(root, '.owlat-last-rollout.json'), JSON.stringify(record));
		return (await runLib('on_trial', {}, root)).code;
	}
	const armed = { state: 'armed', deployStarted: true };
	const verifying = { phase: 'verifying' };

	it('holds while the deployed release is waiting in the readiness check on an armed snapshot', async () => {
		expect(await trial(armed, verifying)).toBe(0);
	});

	it('ends once the rollback begins, or before the deploy and the recreate', async () => {
		expect(await trial(armed, { phase: 'rolling-back' })).not.toBe(0);
		expect(await trial(armed, { phase: 'applying' })).not.toBe(0);
		expect(await trial({ state: 'restoring', deployStarted: true }, verifying)).not.toBe(0);
		expect(await trial({ state: 'armed', deployStarted: false }, verifying)).not.toBe(0);
	});
});

describe('verify_convex_data after a rollback', () => {
	const contact = 'c'.padEnd(32, '0');

	/**
	 * The baseline seeded at FROM 1.2.0, and a reload in which a TO 1.3.0
	 * migration rewrote the contact's name, which the allowlist permits for an
	 * update to 1.3.0.
	 */
	async function check(version: string) {
		const root = await scratch();
		const rows = { contacts: [contact], campaigns: [], emailSends: [], emailTemplates: [] };
		const baseline = join(root, 'baseline.json');
		await writeFile(
			baseline,
			JSON.stringify({
				manifest: { [contact]: { invariant: 'contact', label: 'contact', strict: false } },
				docs: { [contact]: { _id: contact, firstName: 'Ada' } },
				rows,
			})
		);
		const reload = join(root, 'reload.json');
		await writeFile(
			reload,
			JSON.stringify({ docs: { [contact]: { _id: contact, firstName: 'ADA' } }, rows })
		);
		return runLib(
			`DATA_REWRITE_ALLOWLIST="$ALLOW"; convex_cli() { echo "convex_cli $*" >&2; }; convex_query() { cat "$RELOAD"; }; verify_convex_data "$BASELINE" ${version}`,
			{
				BASELINE: baseline,
				RELOAD: reload,
				ALLOW: JSON.stringify([
					{ to: '1.3.0', doc: 'contact', field: 'firstName', migration: 'migrations/0001_x.ts' },
				]),
			}
		);
	}

	it('allows a rewrite TO ships when the stack is on TO', async () => {
		const { code, stdout } = await check('1.3.0');
		expect(code).toBe(0);
		expect(stdout).toContain('contact is intact at 1.3.0');
	});

	it('compares against FROM after a rollback, where no TO rewrite is allowed', async () => {
		const { code, stdout, stderr } = await check('1.2.0');
		expect(code).toBe(1);
		expect(stdout).toContain('contact: contact:firstName "Ada" → "ADA"');
		expect(stderr).toContain('the Convex data seeded at 1.2.0 is not intact at 1.2.0');
		// The stats rollup runs through the restored release's functions.
		expect(stderr).toContain('convex_cli convex run campaigns/statShards:rollupSentCampaignStats');
	});
});
