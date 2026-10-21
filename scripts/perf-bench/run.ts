/**
 * `bun run perf:bench`: report-only benchmarks of web hot paths (plan item
 * OW-072, "Evidence before expensive optimization") and the timing side of the
 * hostile-input scaling checks.
 *
 *   bun run perf:bench -- --machine "reference laptop" [--runs 5]
 *     [--family structural-sharing|preview-regenerate|postbox-strip-scaling|
 *      postbox-consent-scaling] [--out dir]
 *
 * Families:
 * - structural-sharing: `shareStructure` (apps/web/app/lib/structuralSharing.ts)
 *   reconciling a Postbox `listMessages` page, which every live update of the
 *   list goes through (useConvexQuery `accept`).
 * - preview-regenerate: the email builder's `usePreview` regenerate and
 *   dark-mode paths (packages/email-builder/src/composables/usePreview.ts) on
 *   canvases built with the editor's own block factory.
 * - postbox-strip-scaling: `stripRemoteImages` (packages/shared) on each hostile
 *   body its tests hold to linear counted work, at n and 4n.
 * - postbox-consent-scaling: `applyPostboxImageConsent` (apps/web) the same way.
 *   The tests count work and never time it; these two families report the
 *   wall-clock ratio, which also sees regex backtracking no counter can.
 *
 * Each run is a separate `vitest run` of the family's spec with
 * OWLAT_PERF_BENCH_OUT set, so engine state never carries over between runs and
 * the module resolution is exactly the test suite's. The report goes to stdout
 * and, with every raw sample and vitest log, to the output directory (default
 * `.perf-bench/<timestamp>/`, ignored by git).
 *
 * Nothing is gated: the exit code reflects only whether every run completed.
 * Do not wire this into CI as a pass/fail check; shared runners are too noisy
 * for that, and no budget has been agreed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, arch, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { FamilyResult } from './sample';
import { PERF_BENCH_OUT_ENV } from './sample';
import { aggregateFamily, aggregateScaling, renderReport, type ReportContext } from './stats';

const ROOT = resolve(import.meta.dir, '../..');
const VITEST = join(ROOT, 'node_modules/.bin/vitest');

const FAMILIES = {
	'structural-sharing': {
		workspace: 'apps/web',
		spec: 'app/lib/__tests__/structuralSharing.perf.test.ts',
	},
	'preview-regenerate': {
		workspace: 'packages/email-builder',
		spec: 'src/composables/__tests__/usePreview.perf.test.ts',
	},
	'postbox-strip-scaling': {
		workspace: 'packages/shared',
		spec: 'src/__tests__/postboxTrackers.perf.test.ts',
	},
	'postbox-consent-scaling': {
		workspace: 'apps/web',
		spec: 'app/utils/__tests__/postboxRemoteResources.perf.test.ts',
	},
} as const;
type FamilyName = keyof typeof FAMILIES;

function isFamily(name: string): name is FamilyName {
	return Object.hasOwn(FAMILIES, name);
}

function git(args: string[]): string {
	const out = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim() : 'unknown';
}

function readOrUnknown(path: string): string {
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		return 'unknown';
	}
}

function loadAverage(): string {
	return loadavg()
		.map((v) => v.toFixed(2))
		.join(' / ');
}

function main(): number {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			machine: { type: 'string' },
			runs: { type: 'string', default: '5' },
			family: { type: 'string', multiple: true },
			out: { type: 'string' },
		},
	});
	const runs = Number(values.runs);
	if (!Number.isInteger(runs) || runs < 1) {
		console.error(`--runs must be a positive integer, got "${values.runs}"`);
		return 2;
	}
	const requested = values.family ?? Object.keys(FAMILIES);
	const unknown = requested.filter((name) => !isFamily(name));
	if (unknown.length > 0) {
		console.error(
			`unknown family: ${unknown.join(', ')} (known: ${Object.keys(FAMILIES).join(', ')})`
		);
		return 2;
	}
	const families = requested.filter(isFamily);

	const startedAt = new Date().toISOString();
	const outDir = resolve(values.out ?? join(ROOT, '.perf-bench', startedAt.replace(/[:.]/g, '-')));
	mkdirSync(outDir, { recursive: true });

	const dirty = git(['status', '--porcelain']) !== '';
	const cpuList = cpus();
	const context: ReportContext = {
		machine: values.machine ?? 'unnamed (pass --machine to name the reference hardware)',
		cpu: cpuList[0]?.model.trim() ?? 'unknown',
		cores: cpuList.length,
		memoryGiB: Math.round(totalmem() / 2 ** 30),
		os: `${platform()} ${release()} ${arch()}`,
		cpuGovernor: readOrUnknown('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
		bun: Bun.version,
		vitest: JSON.parse(readFileSync(join(ROOT, 'node_modules/vitest/package.json'), 'utf8'))
			.version,
		commit: `${git(['rev-parse', '--short=12', 'HEAD'])}${dirty ? ' (uncommitted changes)' : ''}`,
		startedAt,
		loadBefore: loadAverage(),
		loadAfter: '',
	};

	const collected: Array<{ runs: FamilyResult[] }> = [];
	for (const name of families) {
		const { workspace, spec } = FAMILIES[name];
		const results: FamilyResult[] = [];
		for (let i = 1; i <= runs; i++) {
			const resultPath = join(outDir, `${name}.run-${i}.json`);
			// A reused --out directory must not let an earlier run's file stand in for this one.
			rmSync(resultPath, { force: true });
			console.error(`[perf-bench] ${name} run ${i}/${runs}`);
			const proc = spawnSync(VITEST, ['run', spec, '--maxWorkers=1'], {
				cwd: join(ROOT, workspace),
				env: { ...process.env, [PERF_BENCH_OUT_ENV]: resultPath },
				encoding: 'utf8',
			});
			writeFileSync(join(outDir, `${name}.run-${i}.log`), `${proc.stdout}${proc.stderr}`);
			if (proc.status !== 0 || !existsSync(resultPath)) {
				console.error(
					`[perf-bench] ${name} run ${i} failed (exit ${proc.status}); see ${name}.run-${i}.log in ${outDir}`
				);
				return 1;
			}
			results.push(JSON.parse(readFileSync(resultPath, 'utf8')) as FamilyResult);
		}
		collected.push({ runs: results });
	}
	context.loadAfter = loadAverage();

	const report = renderReport(context, collected);
	const summary = {
		context,
		families: collected.map(({ runs: familyRuns }) => ({
			family: familyRuns[0]?.family,
			dataset: familyRuns[0]?.dataset,
			tasks: aggregateFamily(familyRuns),
			scaling: aggregateScaling(familyRuns),
		})),
	};
	writeFileSync(join(outDir, 'report.md'), report);
	writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, '\t')}\n`);
	process.stdout.write(`${report}\n`);
	console.error(`[perf-bench] raw samples, logs and report in ${outDir}`);
	return 0;
}

process.exit(main());
