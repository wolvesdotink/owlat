/**
 * The Markdown report: the budget verdict, reference machine, the limits the
 * fixtures obey, and per scenario its counters (with whether they held across
 * runs and their budget) and its timings (with their spread). Pure, so a test
 * can pin its shape.
 */
import {
	budgetLabel,
	formatBudgetFailure,
	type BudgetFailure,
	type ScenarioBudgets,
} from './budgets';
import type { FidelitySentinels } from './fixtureApi';
import { SCENARIO_NOW } from './browserContext';
import type { MetricSummary } from './stats';
import { ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS, CHARS_PER_TOKEN, WRITER_LIMITS } from './workload';

export interface Environment {
	cpu: string;
	logicalCores: number;
	memoryGb: number;
	os: string;
	browser: string;
	headless: boolean;
	runtime: string;
	vue: string;
	commit: string;
	cpuThrottle: number;
	viewport: string;
	/** The browser's timezone and locale, pinned by perf/browserContext.ts and checked in the page. */
	timezone: string;
	locale: string;
	repeats: number;
	startedAt: string;
}

export interface ScenarioResult {
	id: string;
	description: string;
	metrics: MetricSummary[];
	/** Sentinels from every run that reported one; any entry voids the scenario. */
	voided: FidelitySentinels[];
	/** The scenario's committed budgets (perf/budgets.ts). */
	budgets: ScenarioBudgets | undefined;
}

export interface Report {
	environment: Environment;
	scenarios: ScenarioResult[];
	/** Every run's budget breaches; empty when all of them held. */
	budgetFailures: BudgetFailure[];
}

const fmt = (value: number) => {
	if (!Number.isFinite(value)) return 'n/a';
	if (Number.isInteger(value)) return value.toLocaleString('en-US');
	return value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
};
const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a');

function scenarioSection(result: ScenarioResult): string[] {
	const lines = [`## ${result.id}`, '', result.description, ''];
	if (result.voided.length > 0) {
		lines.push(
			'**VOID: the fixture did not render the real components cleanly; ignore the numbers below.**',
			''
		);
		for (const s of result.voided) {
			for (const e of s.vueErrors) lines.push(`- error: ${e}`);
			for (const c of s.unresolvedComponents) lines.push(`- unresolved component: <${c}>`);
			for (const k of s.missingI18nKeys) lines.push(`- missing message key: ${k}`);
		}
		lines.push('');
	}
	const counters = result.metrics.filter((m) => m.kind === 'counter');
	const timings = result.metrics.filter((m) => m.kind === 'timing');
	lines.push(
		'| Counter | Median | Min | Max | Same every run | Budget |',
		'| --- | ---: | ---: | ---: | :---: | ---: |'
	);
	for (const m of counters) {
		const unit = m.unit === 'count' ? '' : ` (${m.unit})`;
		const budget = budgetLabel(result.budgets?.[m.name]);
		lines.push(
			`| ${m.name}${unit} | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${m.stable ? 'yes' : 'no'} | ${budget} |`
		);
	}
	lines.push(
		'',
		'| Timing | Median | Min | Max | Stdev | CV |',
		'| --- | ---: | ---: | ---: | ---: | ---: |'
	);
	for (const m of timings) {
		lines.push(
			`| ${m.name} (${m.unit}) | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${fmt(m.stdev)} | ${pct(m.cv)} |`
		);
	}
	lines.push('');
	return lines;
}

function budgetSection(failures: readonly BudgetFailure[]): string[] {
	if (failures.length === 0) return ['**Budgets: every run held every budget.**', ''];
	return [
		`**Budgets: ${failures.length} breach${failures.length === 1 ? '' : 'es'}.**`,
		'',
		...failures.map((f) => `- ${formatBudgetFailure(f)}`),
		'',
	];
}

export function formatReport(report: Report): string {
	const env = report.environment;
	const lines = [
		'# Component performance scenarios',
		'',
		'Counters are work the browser and Vue did and should come out the same on every run; a counter',
		'with a budget (perf/budgets.ts) fails the run past it. Timings are wall-clock on the machine below',
		'and carry no pass/fail threshold.',
		'',
		...budgetSection(report.budgetFailures),
		'## Reference machine',
		'',
		'| | |',
		'| --- | --- |',
		`| CPU | ${env.cpu} (${env.logicalCores} logical cores) |`,
		`| Memory | ${env.memoryGb} GB |`,
		`| OS | ${env.os} |`,
		`| Browser | ${env.browser}${env.headless ? ' (headless)' : ''} |`,
		`| Runtime | ${env.runtime} |`,
		`| Vue | ${env.vue} |`,
		`| Commit | ${env.commit} |`,
		`| CPU throttle | ${env.cpuThrottle}× |`,
		`| Viewport | ${env.viewport} |`,
		`| Timezone | ${env.timezone} |`,
		`| Browser locale | ${env.locale} (the components' messages and formats: en) |`,
		`| Runs | ${env.repeats} per scenario, each on a fresh page |`,
		`| Started | ${env.startedAt} |`,
		'',
		'## Limits the fixtures obey',
		'',
		`- Assistant stream: one write per ${WRITER_LIMITS.assistantFlushIntervalMs} ms; answers end at or before an estimated ${fmt(ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS)} characters (the ${fmt(WRITER_LIMITS.assistantMaxOutputTokens)}-token output cap at an assumed ${CHARS_PER_TOKEN} characters per token; the text is never tokenized); questions at most ${fmt(WRITER_LIMITS.assistantQuestionMaxChars)} characters; at most ${WRITER_LIMITS.assistantHistoryLimit} messages loaded.`,
		`- Chat room: at most ${WRITER_LIMITS.chatHistoryLimit} messages loaded, each at most ${fmt(WRITER_LIMITS.chatMessageMaxChars)} characters.`,
		`- Clock: the page's \`Date.now()\` is pinned to ${new Date(SCENARIO_NOW).toISOString()}; timers and frames run at real speed.`,
		'',
	];
	for (const result of report.scenarios) lines.push(...scenarioSection(result));
	return lines.join('\n');
}
