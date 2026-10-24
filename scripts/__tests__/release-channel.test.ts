/**
 * A release candidate (`vX.Y.Z-rc.N`) runs the whole unified release pipeline
 * but must never reach an install that did not ask for it. These checks pin
 * both halves: what release.yml does with a candidate, and that the default
 * consumers skip a candidate published after the newest stable release.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8');

interface Step {
	run?: string;
	uses?: string;
	if?: string;
	with?: Record<string, unknown>;
}
interface Job {
	if?: string;
	needs?: string[];
	uses?: string;
	outputs?: Record<string, string>;
	steps?: Step[];
	with?: Record<string, unknown>;
}
const workflow = (file: string) => parse(read(file)) as { jobs: Record<string, Job> };

describe('release.yml with a candidate tag', () => {
	const { jobs } = workflow('.github/workflows/release.yml');

	it('classifies the tag through the release policy before anything runs', () => {
		const gate = jobs['resolve']!.steps!.find((step) => step.run?.includes('release-gate.ts'));
		expect(gate).toBeDefined();
		expect(jobs['resolve']!.outputs).toMatchObject({
			version: '${{ steps.meta.outputs.version }}',
			channel: '${{ steps.meta.outputs.channel }}',
		});
		expect(jobs['verify']!.needs).toContain('resolve');
	});

	it('runs verification, both builds and the update flow for every channel', () => {
		for (const name of [
			'verify',
			'create-release',
			'server',
			'desktop',
			'publish',
			'update-versions',
		])
			expect(jobs[name]!.if, name).toBeUndefined();
		expect(jobs['post-publish-update']!.if).toBe("needs.update-versions.outputs.from != ''");
		expect(jobs['post-publish-update']!.uses).toBe('./.github/workflows/update-flow.yml');
	});

	it('publishes a candidate as a prerelease that never claims latest', () => {
		const create = jobs['create-release']!.steps!.find((step) => step.with?.['prerelease']);
		expect(create!.with!['prerelease']).toBe("${{ needs.resolve.outputs.channel != 'stable' }}");
		const publish = jobs['publish']!.steps!.find((step) => step.run?.includes('gh release edit'))!;
		expect(publish.run).toMatch(
			/"\$CHANNEL" != stable \]\]; then\n\s+gh release edit[^\n]*--prerelease --latest=false\n/
		);
		expect(publish.run).toMatch(/else\n\s+gh release edit[^\n]*--latest\n/);
	});

	it('moves the image aliases for stable releases only', () => {
		expect(jobs['promote-aliases']!.if).toBe("needs.resolve.outputs.channel == 'stable'");
	});
});

describe('desktop builds of a candidate', () => {
	it('give the Windows installer a numeric version before Tauri bundles it', () => {
		const steps = workflow('.github/workflows/_desktop-build.yml').jobs['build']!.steps!;
		const msi = steps.findIndex((step) => step.run?.includes('scripts/ci/msi-version.ts'));
		const bundle = steps.findIndex((step) => step.uses?.startsWith('tauri-apps/tauri-action'));
		expect(msi).toBeGreaterThan(-1);
		expect(msi).toBeLessThan(bundle);
		expect(steps[msi]!.if).toBe("runner.os == 'Windows'");
	});
});

describe('desktop apps outside a managed prerelease channel', () => {
	it("update from the latest.json of GitHub's latest release, which is never a prerelease", () => {
		const config = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')) as {
			plugins: { updater: { endpoints: string[] } };
		};
		expect(config.plugins.updater.endpoints).toEqual([
			'https://github.com/wolvesdotink/owlat/releases/latest/download/latest.json',
		]);
	});
});

describe('install.sh with a candidate newer than the stable release', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'owlat-rc-install-'));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const fixture = join(scratch, 'releases.json');
	writeFileSync(
		fixture,
		JSON.stringify([
			{ tag_name: 'v0.7.0-rc.2', prerelease: true },
			{ tag_name: 'server-v0.6.20', prerelease: false },
			{ tag_name: 'v0.7.0-rc.1', prerelease: true },
			{ tag_name: 'v0.6.16', prerelease: false },
		])
	);
	const install = read('install.sh');
	const resolveRef = /^resolve_ref\(\) \{\n[\s\S]*?\n\}\n/m.exec(install)![0];

	function resolve(ref: string): string {
		const script = `
info() { echo "info: $*" >&2; }
warn() { echo "warn: $*" >&2; }
die() { echo "die: $*" >&2; exit 1; }
curl() { cat "$FIXTURE"; printf '\\n200'; }
OWLAT_GH_SLUG=example/owlat
OWLAT_REF="$REQUESTED"
${resolveRef}
resolve_ref
printf '%s' "$OWLAT_REF"
`;
		return execFileSync('bash', ['-c', script], {
			encoding: 'utf8',
			env: { PATH: process.env['PATH'], FIXTURE: fixture, REQUESTED: ref },
			stdio: ['ignore', 'pipe', 'ignore'],
		});
	}

	it('installs the newest stable release by default', () => {
		expect(resolve('')).toBe('v0.6.16');
	});

	it('installs a candidate when asked for it by name', () => {
		expect(resolve('v0.7.0-rc.2')).toBe('v0.7.0-rc.2');
	});
});
