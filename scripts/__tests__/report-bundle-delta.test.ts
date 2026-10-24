/**
 * The per-pull-request entry bundle delta.
 *
 * Reports are the shape `report-bundle-closures.ts --json` writes. The rules
 * pinned here are the ones that keep the report honest: a missing base is said
 * to be missing (never a zero delta), growth and low headroom are flagged, and
 * only chunks and closures that really moved are listed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ENTRY_GROWTH_WARN_BYTES,
	HEADROOM_WARN_BYTES,
	renderDelta,
	type BundleReport,
} from '../report-bundle-delta';
import { GZIP_BUDGET_KB } from '../check-bundle-budget';

const SCRIPT = resolve(import.meta.dirname, '../report-bundle-delta.ts');
const BUDGET = 250 * 1024;

const sandboxes: string[] = [];
afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function report(
	entryGzip: number,
	options: {
		sha?: string;
		toolchain?: string;
		chunks?: Array<[string, number]>;
		routes?: Record<string, number>;
		deferred?: Record<string, number>;
	} = {}
): BundleReport {
	const closures = (sizes: Record<string, number>) =>
		Object.entries(sizes).map(([key, gzip]) => ({
			key,
			beyondEntry: { files: 1, raw: gzip * 3, gzip },
		}));
	return {
		meta: { sha: options.sha ?? null, toolchain: options.toolchain ?? 'bun-1.4.2' },
		entry: {
			closure: { files: 60, raw: entryGzip * 3, gzip: entryGzip },
			chunks: (options.chunks ?? []).map(([key, gzip]) => ({ key, gzip })),
		},
		routes: closures(options.routes ?? {}),
		deferred: closures(options.deferred ?? {}),
	};
}

const delta = (head: BundleReport, base: BundleReport | null, unavailable: string | null = null) =>
	renderDelta({ head, base, baseSha: 'base0000sha1', unavailable, budgetBytes: BUDGET });

describe('the entry bundle delta report', () => {
	it('says there is no comparison when the base report is missing, never a zero delta', () => {
		const { markdown, warnings } = delta(
			report(236 * 1024, { sha: 'head1111sha2' }),
			null,
			'No successful report was kept for the base commit.'
		);

		expect(markdown).toContain('Head `head1111sha2`: **236.0 KiB** gzip in 60 files');
		expect(markdown).toContain('headroom **14.0 KiB**');
		expect(markdown).toContain(
			'Base `base0000sha1`: **no comparison**. No successful report was kept for the base commit.'
		);
		expect(markdown).toContain('The delta is unknown, not zero.');
		expect(markdown).not.toContain('Delta ');
		expect(warnings).toEqual([]);
	});

	it('reports the delta and flags growth of half a KiB or more', () => {
		const base = report(236 * 1024);
		const grown = delta(report(236 * 1024 + ENTRY_GROWTH_WARN_BYTES), base);
		const nudged = delta(report(236 * 1024 + ENTRY_GROWTH_WARN_BYTES - 1), base);
		const shrunk = delta(report(230 * 1024), base);

		expect(grown.markdown).toContain('**Delta +0.5 KiB**');
		expect(grown.warnings).toHaveLength(1);
		expect(grown.warnings[0]).toContain('grew by 0.5 KiB');
		expect(nudged.warnings).toEqual([]);
		expect(shrunk.markdown).toContain('**Delta −6.0 KiB**');
		expect(shrunk.warnings).toEqual([]);
	});

	it('flags headroom below 8 KiB, with or without a base', () => {
		const tight = report(BUDGET - HEADROOM_WARN_BYTES + 1);

		expect(delta(tight, null, 'none').warnings[0]).toContain('left under its 250.0 KiB budget');
		expect(delta(tight, tight).warnings).toHaveLength(1);
		expect(delta(report(BUDGET - HEADROOM_WARN_BYTES), null, 'none').warnings).toEqual([]);
	});

	it('lists the entry chunks that moved, by name, including new and removed ones', () => {
		const base = report(236 * 1024, {
			chunks: [
				['vue', 25_000],
				['useAuth', 6_000],
				['useOrganization', 2_300],
				['d1.js', 900],
			],
		});
		const head = report(233 * 1024, {
			chunks: [
				['vue', 25_050],
				['useAuth', 2_500],
				['useOrganizationSession', 700],
				['d1.js', 900],
			],
		});

		const { markdown } = delta(head, base);

		expect(markdown).toContain('| `useAuth` | 5.9 | 2.4 | −3.4 |');
		expect(markdown).toContain('| `useOrganization` | 2.2 | — | −2.2 |');
		expect(markdown).toContain('| `useOrganizationSession` | — | 0.7 | +0.7 |');
		// 50 bytes is hash and preload-map churn; an unchanged unnamed chunk is not news.
		expect(markdown).not.toContain('`vue`');
		expect(markdown).not.toContain('d1.js');
	});

	it('does not compare entry chunks with a report that has no chunk rows', () => {
		const head = report(233 * 1024, { chunks: [['useAuth', 2_500]] });
		const { chunks: _chunks, ...olderEntry } = report(236 * 1024).entry;

		const { markdown } = delta(head, { ...report(236 * 1024), entry: olderEntry });

		expect(markdown).toContain('**Delta −3.0 KiB**');
		expect(markdown).toContain('Entry chunks: not compared, one of the reports has no chunk rows.');
		expect(markdown).not.toContain('`useAuth`');
	});

	it('lists route and deferred closures that moved by 1 KiB or more', () => {
		const base = report(236 * 1024, {
			routes: { 'pages/auth/login.vue': 8_000, 'pages/index.vue': 5_000 },
			deferred: { 'components/Palette.vue': 38_000 },
		});
		const head = report(236 * 1024, {
			routes: { 'pages/auth/login.vue': 11_500, 'pages/index.vue': 5_500 },
			deferred: { 'components/Palette.vue': 38_000, 'lib/desktop/desktopBoot.client.ts': 9_000 },
		});

		const { markdown } = delta(head, base);

		expect(markdown).toContain('| deferred `lib/desktop/desktopBoot.client.ts` | — | 8.8 | +8.8 |');
		expect(markdown).toContain('| route `pages/auth/login.vue` | 7.8 | 11.2 | +3.4 |');
		expect(markdown).not.toContain('pages/index.vue');
		expect(markdown).not.toContain('Palette');
	});

	it('says when the two builds used different toolchains', () => {
		const { markdown } = delta(
			report(236 * 1024, { toolchain: 'bun-1.4.3' }),
			report(236 * 1024, { toolchain: 'bun-1.4.2' })
		);

		expect(markdown).toContain('different toolchains (base `bun-1.4.2`, head `bun-1.4.3`)');
	});
});

describe('the delta report command', () => {
	function files(reports: Record<string, BundleReport | string>): string {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-bundle-delta-'));
		sandboxes.push(dir);
		for (const [name, content] of Object.entries(reports)) {
			writeFileSync(
				join(dir, name),
				typeof content === 'string' ? content : JSON.stringify(content)
			);
		}
		return dir;
	}

	function run(args: string[], env: Record<string, string> = {}) {
		const { GITHUB_STEP_SUMMARY: _summary, ...inherited } = process.env;
		const result = spawnSync('bun', [SCRIPT, ...args], {
			encoding: 'utf8',
			env: { ...inherited, ...env },
		});
		return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
	}

	it('reads the budget from the entry gate and writes the job summary', () => {
		const dir = files({
			'head.json': report(GZIP_BUDGET_KB * 1024 - 4 * 1024),
			'base.json': report(GZIP_BUDGET_KB * 1024 - 5 * 1024),
			'summary.md': '',
		});

		const result = run(
			[join(dir, 'head.json'), join(dir, 'base.json'), '--base-sha', 'base0000sha1'],
			{ GITHUB_STEP_SUMMARY: join(dir, 'summary.md') }
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`budget ${GZIP_BUDGET_KB}.0 KiB, headroom **4.0 KiB**`);
		expect(result.stdout).toContain('**Delta +1.0 KiB**');
		expect(result.stdout).toContain('::warning title=Web entry bundle::');
		expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('### Web entry bundle');
	});

	it('reports a base report that is not there as unavailable', () => {
		const dir = files({ 'head.json': report(236 * 1024) });

		const result = run([join(dir, 'head.json'), join(dir, 'base.json'), '--base-sha', 'cafe']);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Base `cafe`: **no comparison**.');
		expect(result.stdout).toContain('does not exist');
	});

	it('passes on the reason CI could not fetch a base report', () => {
		const dir = files({ 'head.json': report(236 * 1024) });

		const result = run([
			join(dir, 'head.json'),
			'--base-sha',
			'cafe',
			'--unavailable',
			'The base commit has no kept report yet.',
		]);

		expect(result.stdout).toContain('**no comparison**. The base commit has no kept report yet.');
	});

	it('refuses an unreadable head report', () => {
		const dir = files({ 'head.json': '{"entry":{}}' });

		const result = run([join(dir, 'head.json')]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain('cannot read the report');
	});
});
