/**
 * The update flow gates publication: both release pipelines (the unified `v*`
 * one and the server-only `server-v*` one) may only flip their draft live once
 * the previous stable release has updated to the draft, and a failed release
 * has been rolled back, through the real updater. These cases read the parsed
 * workflows and pin that graph: where the gate sits, what it tests, and that
 * it runs on a Docker daemon of its own.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8');

interface Step {
	id?: string;
	name?: string;
	run?: string;
	uses?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}
interface Job {
	if?: string;
	needs?: string | string[];
	uses?: string;
	'timeout-minutes'?: number;
	outputs?: Record<string, string>;
	strategy?: { matrix?: Record<string, unknown> };
	steps?: Step[];
	with?: Record<string, unknown>;
	env?: Record<string, string>;
}
interface Workflow {
	on: Record<string, { inputs?: Record<string, { required?: boolean }> } | null>;
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
}
const workflow = (file: string) => parse(read(`.github/workflows/${file}`)) as Workflow;

const needsOf = (job: Job) => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));

/** Every job `name` waits for, directly or through another job. */
function requires(jobs: Record<string, Job>, name: string): Set<string> {
	const seen = new Set<string>();
	const visit = (job: string) => {
		for (const need of needsOf(jobs[job]!)) {
			expect(jobs[need], `${job} needs a job that does not exist: ${need}`).toBeDefined();
			if (!seen.has(need)) {
				seen.add(need);
				visit(need);
			}
		}
	};
	visit(name);
	return seen;
}

const SERVER_BUILD = './.github/workflows/_server-build.yml';
const UPDATE_FLOW = './.github/workflows/update-flow.yml';

describe.each(['release.yml', 'server-release.yml'])('publication in %s', (file) => {
	const { jobs } = workflow(file);

	it('waits for the reusable server core, unconditionally', () => {
		expect(jobs['server']!.uses).toBe(SERVER_BUILD);
		expect(jobs['server']!.with).toMatchObject({
			version: '${{ needs.resolve.outputs.version }}',
			tag: '${{ github.ref_name }}',
		});
		expect(requires(jobs, 'publish')).toContain('server');
		// A gate that failed or was cancelled leaves `server` failed, which
		// skips `publish`; an `always()` or a status override would let it run.
		expect(jobs['publish']!.if).toBeUndefined();
	});

	it('runs no update flow of its own, before or after publication', () => {
		for (const [name, job] of Object.entries(jobs)) expect(job.uses, name).not.toBe(UPDATE_FLOW);
	});
});

describe('the update gate in _server-build.yml', () => {
	const { jobs } = workflow('_server-build.yml');

	it('tests the draft once its compose assets are uploaded and its images pull anonymously', () => {
		const gate = jobs['update-gate']!;
		expect(gate.uses).toBe(UPDATE_FLOW);
		expect(requires(jobs, 'update-gate')).toEqual(
			new Set([
				'update-target',
				'upload-release-assets',
				'verify-anonymous-pull',
				'merge-manifests',
				'build-and-push',
				'resolve',
			])
		);
		expect(gate.with).toEqual({
			from: '${{ needs.update-target.outputs.from }}',
			to: '${{ inputs.version }}',
			target_artifact: '${{ needs.update-target.outputs.artifact }}',
		});
	});

	it('is skipped only when there is no earlier stable release, and says so', () => {
		expect(jobs['update-gate']!.if).toBe("needs.update-target.outputs.from != ''");
		const steps = jobs['update-target']!.steps!;
		const pair = steps.find((step) => step.id === 'pair')!;
		// The one previous-stable policy (aliases.ts previousRelease).
		expect(pair.run).toBe('bun scripts/ci/resolve-update.ts');
		const notice = steps.find((step) => step.if === "steps.pair.outputs.from == ''")!;
		expect(notice.run).toContain('::notice::');
		expect(jobs['update-target']!.outputs!['from']).toBe('${{ steps.pair.outputs.from }}');
	});

	it("downloads the draft's own template by its tag, with credentials, and checks it", () => {
		const job = jobs['update-target']!;
		expect(job.env).toMatchObject({
			GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
			VERSION: '${{ inputs.version }}',
			// `server-v<version>` for a server-only release, not `v<version>`.
			TAG: '${{ inputs.tag }}',
		});
		const download = job.steps!.find((step) => step.id === 'target')!;
		expect(download.run).toContain('gh release download "$TAG"');
		expect(download.run).toContain('sha256sum -c "docker-compose-${VERSION}.yml.sha256"');
		expect(download.run).toContain('artifact=update-target-${VERSION}');
		const upload = job.steps!.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!;
		expect(upload.with).toMatchObject({
			name: 'update-target-${{ inputs.version }}',
			'if-no-files-found': 'error',
		});
	});
});

describe('update-flow.yml', () => {
	const flow = workflow('update-flow.yml');
	const job = flow.jobs['update-flow']!;
	const steps = job.steps!;

	it('takes a draft target as a run artifact and keeps a read-only token', () => {
		const inputs = flow.on['workflow_call']!.inputs!;
		expect(Object.keys(inputs).sort()).toEqual(['from', 'target_artifact', 'to']);
		expect(inputs['target_artifact']!.required).toBe(false);
		expect(flow.permissions).toEqual({ contents: 'read' });
		const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))!;
		expect(download.if).toBe('inputs.target_artifact');
		expect(download.with!['name']).toBe('${{ inputs.target_artifact }}');
	});

	it('runs the successful update and the rolled-back one, each bounded', () => {
		expect(job.strategy!.matrix!['scenario']).toEqual(['success', 'rollback']);
		expect(job['timeout-minutes']).toBeGreaterThan(0);
		const run = steps.find((step) => step.run?.includes('e2e-update-flow-dind.sh'))!;
		expect(run.env).toMatchObject({
			SCENARIO: '${{ matrix.scenario }}',
			TEMPLATE_DIR:
				"${{ inputs.target_artifact && format('{0}/update-target', runner.temp) || '' }}",
			FROM: '${{ steps.versions.outputs.from }}',
			TO: '${{ steps.versions.outputs.to }}',
		});
		// Only the nightly and dispatch runs may pass on a pair they could not
		// test; the release gate (a tag push) and pull requests may not.
		expect(run.env!['STRICT']).toBe(
			"${{ (github.event_name != 'schedule' && github.event_name != 'workflow_dispatch') && '1' || '0' }}"
		);
	});

	it("never drives or prunes the runner's own Docker daemon", () => {
		for (const step of steps) {
			const script = step.run ?? '';
			expect(script, step.name).not.toMatch(/docker\s+(system|image|volume|container)\s+prune/);
			expect(script, step.name).not.toMatch(/e2e-update-flow\.sh/);
			expect(script, step.name).not.toMatch(/\bsudo\b[^\n]*docker/);
		}
	});
});

describe('e2e-update-flow-dind.sh', () => {
	const script = read('scripts/e2e-update-flow-dind.sh');

	it('runs the harness inside a pinned docker:dind container, without the host socket', () => {
		expect(script).toMatch(/DIND_IMAGE='docker:[0-9.]+-dind@sha256:[0-9a-f]{64}'/);
		expect(script).not.toContain('/var/run/docker.sock');
		expect(script).toContain(
			'docker exec "${flow_env[@]}" "$NAME" bash /src/scripts/e2e-update-flow.sh'
		);
	});

	it('bounds the wait for the daemon and removes the container and its volume by name', () => {
		expect(script).toMatch(/for _ in \$\(seq 1 \d+\); do\n\tif docker exec "\$NAME" docker info/);
		expect(script).toContain('docker rm -f -v "$NAME"');
		expect(script).toContain('docker volume rm "$NAME-docker"');
		expect(script).toMatch(/trap cleanup EXIT/);
	});
});
