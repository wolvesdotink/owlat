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

	it('runs verification, both builds and the update gate for every channel', () => {
		for (const name of ['verify', 'create-release', 'server', 'desktop', 'publish'])
			expect(jobs[name]!.if, name).toBeUndefined();
		// The update gate runs inside `server`, before publication, whatever
		// the channel (scripts/__tests__/update-gate.test.ts).
		expect(jobs['server']!.uses).toBe('./.github/workflows/_server-build.yml');
		expect(jobs['publish']!.needs).toContain('server');
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

describe('the seeded install leg of a candidate', () => {
	it('reads every page of releases to find the stable release it upgrades from', () => {
		const resolvePrevious = Object.values(workflow('.github/workflows/_server-build.yml').jobs)
			.flatMap((job) => job.steps ?? [])
			.find((step) => step.run?.includes('prev_tag=$(gh api'))!;
		expect(resolvePrevious.run).toContain('gh api --paginate');
		expect(resolvePrevious.run).toContain('.prerelease == false');
		expect(resolvePrevious.run).not.toMatch(/\[0\]|\| head\b/);
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
	const install = read('install.sh');
	const resolveRef = /^resolve_ref\(\) \{\n[\s\S]*?\n\}\n/m.exec(install)![0];
	const candidates = (count: number, minor: number) =>
		Array.from({ length: count }, (_, index) => ({
			tag_name: `v0.${minor}.0-rc.${count - index}`,
			prerelease: true,
		}));

	/**
	 * Runs the real `resolve_ref` under install.sh's shell options against a
	 * stubbed GitHub API that serves `pages[n - 1]` for `&page=n` and an empty
	 * list past the end. Returns the chosen ref, or `die: …` when it refuses.
	 */
	function resolve(ref: string, pages: unknown[][], status = 200): string {
		const dir = mkdtempSync(join(scratch, 'pages-'));
		for (const [index, page] of pages.entries())
			writeFileSync(join(dir, `${index + 1}.json`), JSON.stringify(page));
		const script = `
set -euo pipefail
info() { echo "info: $*" >&2; }
warn() { echo "warn: $*" >&2; }
die() { printf 'die: %s' "$1"; exit 1; }
curl() {
	local url="\${*: -1}"
	local page="\${url##*page=}"
	if [[ -f "$PAGES/$page.json" ]]; then cat "$PAGES/$page.json"; else printf '[]'; fi
	printf '\\n%s' "$STATUS"
}
OWLAT_GH_SLUG=example/owlat
OWLAT_REF="$REQUESTED"
${resolveRef}
resolve_ref
printf '%s' "$OWLAT_REF"
`;
		try {
			return execFileSync('bash', ['-c', script], {
				encoding: 'utf8',
				env: { PATH: process.env['PATH'], PAGES: dir, REQUESTED: ref, STATUS: String(status) },
				stdio: ['ignore', 'pipe', 'ignore'],
			});
		} catch (error) {
			return String((error as { stdout?: string }).stdout ?? '');
		}
	}

	const recent = [
		{ tag_name: 'v0.7.0-rc.2', prerelease: true },
		{ tag_name: 'server-v0.6.20', prerelease: false },
		{ tag_name: 'v0.7.0-rc.1', prerelease: true },
		{ tag_name: 'v0.6.16', prerelease: false },
	];

	it('installs the newest stable release by default', () => {
		expect(resolve('', [recent])).toBe('v0.6.16');
	});

	it('installs a candidate when asked for it by name', () => {
		expect(resolve('v0.7.0-rc.2', [recent])).toBe('v0.7.0-rc.2');
	});

	it('pages past a full page of candidates to the stable release behind them', () => {
		const pages = [candidates(100, 7), [{ tag_name: 'v0.6.16', prerelease: false }]];
		expect(resolve('', pages)).toBe('v0.6.16');
	});

	it('falls back to main only when the whole history holds no stable release', () => {
		expect(resolve('', [])).toBe('main');
		expect(resolve('', [candidates(100, 7)])).toBe('main');
		expect(resolve('', [candidates(3, 7)])).toBe('main');
		expect(resolve('', [], 404)).toBe('main');
	});

	it('refuses to install main when the page budget ends before the history does', () => {
		const pages = Array.from({ length: 10 }, (_, index) => candidates(100, 10 + index));
		expect(resolve('', [...pages, [{ tag_name: 'v0.6.16', prerelease: false }]])).toMatch(
			/^die: No stable vX\.Y\.Z release among the newest 1000 releases/
		);
	});

	it('refuses to install main when the API fails', () => {
		expect(resolve('', [recent], 403)).toMatch(/^die: Could not resolve a release/);
	});

	it('hands the pinned ref to the installer, not to curl, in every hint', () => {
		// `OWLAT_REF=x curl … | bash` sets the variable for curl only; the bash
		// that runs the installer never sees it and repeats the failed lookup.
		const pages = Array.from({ length: 10 }, (_, index) => candidates(100, 10 + index));
		expect(resolve('', pages)).toContain('curl … | OWLAT_REF=v1.2.3 bash');
		expect(resolve('', [recent], 403)).toContain('curl … | OWLAT_REF=main bash');
		expect(resolveRef).not.toMatch(/OWLAT_REF=\S+\s+curl/);
	});
});
