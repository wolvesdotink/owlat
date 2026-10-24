/**
 * Component performance scenarios, and the budget gate over their counters.
 *
 *   bun run --cwd apps/web perf:scenarios [--repeats 5] [--only <id or family>]
 *       [--cpu-throttle 1] [--headed] [--out <dir>]
 *
 * Builds the fixture (perf/vite.config.ts) for production, serves it locally,
 * and runs every scenario `--repeats` times in system Chrome, each run on a
 * fresh page: mount, run, unmount. Between those calls it reads Chrome's own
 * counters over the DevTools protocol, forcing a garbage collection before the
 * baseline and after the teardown so "nodes and listeners left" is what the
 * components actually kept alive.
 *
 * Prints the Markdown report and writes it, with the raw per-run samples as
 * JSON, to `--out` (default node_modules/.cache/owlat-perf/reports). Exits 1
 * when a run's fidelity sentinels fired (the fixture did not render the real
 * components cleanly) or when any run of a scenario that ran broke one of its
 * committed counter budgets (perf/budgets.ts). Timings never fail it.
 *
 * Needs no backend, credentials or auth: the scenarios mount components with
 * synthetic props (perf/workload.ts, perf/listWorkload.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession } from '@playwright/test';
import { build, preview } from 'vite';
import { assertPinned, newScenarioContext, SCENARIO_CONTEXT, SCENARIO_NOW } from './browserContext';
import { BUDGETS, checkBudgets, formatBudgetFailure } from './budgets';
import type { FidelitySentinels } from './fixtureApi';
import { formatReport, type Environment, type Report, type ScenarioResult } from './report';
import { SCENARIOS } from './scenarios';
import { counter, summarizeSamples, timing, type Sample } from './stats';

const CONFIG = fileURLToPath(new URL('./vite.config.ts', import.meta.url));

const { values: args } = parseArgs({
	options: {
		repeats: { type: 'string', default: '5' },
		only: { type: 'string', multiple: true },
		'cpu-throttle': { type: 'string', default: '1' },
		headed: { type: 'boolean', default: false },
		out: {
			type: 'string',
			default: fileURLToPath(new URL('../node_modules/.cache/owlat-perf/reports', import.meta.url)),
		},
	},
});
const repeats = Number(args.repeats);
const cpuThrottle = Number(args['cpu-throttle']);
if (!Number.isInteger(repeats) || repeats < 1)
	throw new Error('--repeats must be a positive integer');
if (!(cpuThrottle >= 1)) throw new Error('--cpu-throttle must be 1 or more');
const selected = SCENARIOS.filter(
	(s) => !args.only || args.only.some((o) => o === s.id || o === s.family)
);
if (selected.length === 0) throw new Error(`no scenario matches --only ${args.only?.join(', ')}`);

type Metrics = Record<string, number>;

async function chromeMetrics(cdp: CDPSession): Promise<Metrics> {
	const { metrics } = await cdp.send('Performance.getMetrics');
	return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/**
 * Chrome's counters once garbage that nothing references is gone. Two passes:
 * Blink may still be sweeping the first collection's dead DOM nodes when it
 * returns, and an unswept node still counts in `Nodes`, so a single pass left
 * a whole torn-down tree "alive" in some runs and not in others.
 */
async function settledMetrics(cdp: CDPSession): Promise<Metrics> {
	await cdp.send('HeapProfiler.collectGarbage');
	await cdp.send('HeapProfiler.collectGarbage');
	return chromeMetrics(cdp);
}

const delta = (after: Metrics, before: Metrics, name: string) =>
	(after[name] ?? 0) - (before[name] ?? 0);
/** Chrome reports durations in seconds. */
const deltaMs = (after: Metrics, before: Metrics, name: string) =>
	delta(after, before, name) * 1000;

function prefixed(prefix: string, sample: Sample): Sample {
	return Object.fromEntries(Object.entries(sample).map(([k, v]) => [`${prefix}: ${k}`, v]));
}

function git(...gitArgs: string[]): string {
	try {
		return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

const isVoid = (s: FidelitySentinels) =>
	s.vueErrors.length + s.unresolvedComponents.length + s.missingI18nKeys.length > 0;

const startedAt = new Date().toISOString();
await build({ configFile: CONFIG });
const server = await preview({ configFile: CONFIG, preview: { host: '127.0.0.1', port: 0 } });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('the fixture preview server did not report a URL');

const browser = await chromium.launch({ channel: 'chrome', headless: !args.headed });
const browserVersion = browser.version();
const results: ScenarioResult[] = [];
const raw: Record<string, Sample[]> = {};
try {
	for (const scenario of selected) {
		const samples: Sample[] = [];
		const voided: FidelitySentinels[] = [];
		for (let i = 0; i < repeats; i++) {
			const context = await newScenarioContext(browser);
			const page = await context.newPage();
			// `Date` only: timers and animation frames keep real time.
			await page.clock.setFixedTime(SCENARIO_NOW);
			await page.goto(url);
			await page.waitForFunction(() => window.__owlatPerf !== undefined);
			const resolved = await page.evaluate(() => ({
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				locale: navigator.language,
				now: Date.now(),
			}));
			assertPinned(resolved);
			const cdp = await context.newCDPSession(page);
			await cdp.send('Performance.enable');
			if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });

			const base = await settledMetrics(cdp);
			const mount = await page.evaluate((id) => window.__owlatPerf!.mount(id), scenario.id);
			const mounted = await chromeMetrics(cdp);
			const run = await page.evaluate(() => window.__owlatPerf!.run());
			const ran = await chromeMetrics(cdp);
			const teardown = await page.evaluate(() => window.__owlatPerf!.unmount());
			const after = await settledMetrics(cdp);
			await context.close();

			if (isVoid(teardown.sentinels)) voided.push(teardown.sentinels);
			samples.push({
				...prefixed('mount', {
					...mount,
					'DOM nodes': counter(delta(mounted, base, 'Nodes')),
					layouts: counter(delta(mounted, base, 'LayoutCount')),
					'style recalcs': counter(delta(mounted, base, 'RecalcStyleCount')),
					'layout time': timing(deltaMs(mounted, base, 'LayoutDuration')),
				}),
				...prefixed('run', {
					...run,
					layouts: counter(delta(ran, mounted, 'LayoutCount')),
					'style recalcs': counter(delta(ran, mounted, 'RecalcStyleCount')),
					'layout time': timing(deltaMs(ran, mounted, 'LayoutDuration')),
					'style time': timing(deltaMs(ran, mounted, 'RecalcStyleDuration')),
					'task time': timing(deltaMs(ran, mounted, 'TaskDuration')),
				}),
				...prefixed('teardown', {
					...teardown.sample,
					'DOM nodes left': counter(delta(after, base, 'Nodes')),
					'JS event listeners left': counter(delta(after, base, 'JSEventListeners')),
					'documents left': counter(delta(after, base, 'Documents')),
					'frames left': counter(delta(after, base, 'Frames')),
				}),
			});
			process.stderr.write(`${scenario.id}: run ${i + 1}/${repeats} done\n`);
		}
		raw[scenario.id] = samples;
		results.push({
			id: scenario.id,
			description: scenario.description,
			metrics: summarizeSamples(samples),
			voided,
			budgets: BUDGETS[scenario.id],
		});
	}
} finally {
	await browser.close();
	await server.close();
}

const require = createRequire(import.meta.url);
const sha = git('rev-parse', '--short=12', 'HEAD');
const environment: Environment = {
	cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
	logicalCores: os.cpus().length,
	memoryGb: Math.round(os.totalmem() / 1024 ** 3),
	os: `${os.platform()} ${os.release()}`,
	browser: `Chrome ${browserVersion}`,
	headless: !args.headed,
	runtime: process.versions['bun']
		? `Bun ${process.versions['bun']}`
		: `Node ${process.versions.node}`,
	vue: (require('vue/package.json') as { version: string }).version,
	commit: sha ? `${sha}${git('status', '--porcelain') ? ' (uncommitted changes)' : ''}` : 'unknown',
	cpuThrottle,
	viewport: `${SCENARIO_CONTEXT.viewport.width}×${SCENARIO_CONTEXT.viewport.height} @${SCENARIO_CONTEXT.deviceScaleFactor}x`,
	timezone: SCENARIO_CONTEXT.timezoneId,
	locale: SCENARIO_CONTEXT.locale,
	repeats,
	startedAt,
};
const budgetFailures = checkBudgets(raw);
const report: Report = { environment, scenarios: results, budgetFailures };
const markdown = formatReport(report);

mkdirSync(args.out, { recursive: true });
const stamp = environment.startedAt.replace(/[:.]/g, '-');
writeFileSync(join(args.out, `${stamp}.md`), `${markdown}\n`);
writeFileSync(
	join(args.out, `${stamp}.json`),
	`${JSON.stringify({ ...report, raw }, null, '\t')}\n`
);
process.stdout.write(`${markdown}\n`);
process.stderr.write(`report written to ${join(args.out, stamp)}.{md,json}\n`);
for (const failure of budgetFailures) {
	process.stderr.write(`budget breached: ${formatBudgetFailure(failure)}\n`);
}
if (results.some((r) => r.voided.length > 0) || budgetFailures.length > 0) process.exitCode = 1;
