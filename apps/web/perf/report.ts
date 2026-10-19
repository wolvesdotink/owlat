/**
 * The Markdown report: reference machine, the limits the fixtures obey, and
 * per scenario its counters (with whether they held across runs) and its
 * timings (with their spread). Pure, so a test can pin its shape.
 */
import type { FidelitySentinels } from './fixtureApi';
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
	repeats: number;
	startedAt: string;
}

export interface ScenarioResult {
	id: string;
	description: string;
	metrics: MetricSummary[];
	/** Sentinels from every run that reported one; any entry voids the scenario. */
	voided: FidelitySentinels[];
}

export interface Report {
	environment: Environment;
	scenarios: ScenarioResult[];
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
		'| Counter | Median | Min | Max | Same every run |',
		'| --- | ---: | ---: | ---: | :---: |'
	);
	for (const m of counters) {
		const unit = m.unit === 'count' ? '' : ` (${m.unit})`;
		lines.push(
			`| ${m.name}${unit} | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${m.stable ? 'yes' : 'no'} |`
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

export function formatReport(report: Report): string {
	const env = report.environment;
	const lines = [
		'# Component performance scenarios',
		'',
		'Report-only. Counters are work the browser and Vue did and should come out the same on every run;',
		'timings are wall-clock on the machine below and carry no pass/fail threshold.',
		'',
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
		`| Runs | ${env.repeats} per scenario, each on a fresh page |`,
		`| Started | ${env.startedAt} |`,
		'',
		'## Limits the fixtures obey',
		'',
		`- Assistant stream: one write per ${WRITER_LIMITS.assistantFlushIntervalMs} ms; answers end at or before an estimated ${fmt(ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS)} characters (the ${fmt(WRITER_LIMITS.assistantMaxOutputTokens)}-token output cap at an assumed ${CHARS_PER_TOKEN} characters per token; the text is never tokenized); questions at most ${fmt(WRITER_LIMITS.assistantQuestionMaxChars)} characters; at most ${WRITER_LIMITS.assistantHistoryLimit} messages loaded.`,
		`- Chat room: at most ${WRITER_LIMITS.chatHistoryLimit} messages loaded, each at most ${fmt(WRITER_LIMITS.chatMessageMaxChars)} characters.`,
		'',
	];
	for (const result of report.scenarios) lines.push(...scenarioSection(result));
	return lines.join('\n');
}
