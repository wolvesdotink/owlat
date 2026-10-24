/**
 * What a change does to the web entry bundle, against its base commit.
 * Report-only: the blocking check is `check-bundle-budget.ts`.
 *
 * The entry gate fails only once the closure crosses the budget, so a feature
 * that adds a few hundred bytes passes, and so does the next one, until an
 * unrelated change is the one that fails. This puts the creep in front of every
 * pull request instead: the entry closure's size against the base commit's, the
 * headroom left under the budget, which entry chunks moved, and which routes
 * and deferred features grew or shrank.
 *
 * Both inputs are `report-bundle-closures.ts --json` reports. The base report
 * is the artifact CI kept for the exact base commit; when there is none (its
 * run has not finished, failed, or expired) the comparison is reported as
 * unavailable, never as a zero delta or against some other commit.
 *
 * Prints the summary as Markdown, appending it to `$GITHUB_STEP_SUMMARY` when
 * that is set, and GitHub warning annotations for an entry that grew by
 * ENTRY_GROWTH_WARN_BYTES or more, or has less than HEADROOM_WARN_BYTES left.
 * Exit status is 0 for any sizes, 2 for an unreadable report.
 *
 * Usage: bun scripts/report-bundle-delta.ts <head.json> [<base.json>]
 *          [--base-sha <sha>] [--unavailable <why there is no base report>]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { GZIP_BUDGET_KB } from './check-bundle-budget';
import { kb } from './bundle-closure';

const TOOL = 'report-bundle-delta';

/** An entry that grows by this much needs a sentence in its pull request. */
export const ENTRY_GROWTH_WARN_BYTES = 512;
/** Less headroom than this, and the next feature is likely to fail the gate. */
export const HEADROOM_WARN_BYTES = 8 * 1024;
/** Entry chunks that moved by less are noise (preload-map and hash churn). */
const CHUNK_MOVE_BYTES = 100;
/** Route and deferred closures that moved by less are not listed. */
const CLOSURE_MOVE_BYTES = 1024;
const MAX_ROWS = 10;

interface Totals {
	files: number;
	raw: number;
	gzip: number;
}
interface Closure {
	key: string;
	beyondEntry: Totals;
}
export interface BundleReport {
	meta: { sha?: string | null; toolchain?: string | null };
	entry: {
		closure: Totals;
		chunks?: Array<{ key: string; gzip: number }>;
	};
	routes: Closure[];
	deferred: Closure[];
}

export interface DeltaInput {
	head: BundleReport;
	base: BundleReport | null;
	baseSha: string | null;
	/** Why there is no base report, when there is none. */
	unavailable: string | null;
	budgetBytes: number;
}

const signed = (bytes: number) =>
	`${bytes > 0 ? '+' : bytes < 0 ? '−' : '±'}${kb(Math.abs(bytes))}`;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : 'unknown');

/** Entry chunks by key; chunks that share a name are summed. */
function chunkSizes(report: BundleReport): Map<string, number> {
	const sizes = new Map<string, number>();
	for (const chunk of report.entry.chunks ?? []) {
		sizes.set(chunk.key, (sizes.get(chunk.key) ?? 0) + chunk.gzip);
	}
	return sizes;
}

function moves(
	head: Map<string, number>,
	base: Map<string, number>,
	threshold: number
): Array<{ key: string; base: number | null; head: number | null; delta: number }> {
	const keys = new Set([...head.keys(), ...base.keys()]);
	return [...keys]
		.map((key) => {
			const after = head.get(key) ?? null;
			const before = base.get(key) ?? null;
			return { key, base: before, head: after, delta: (after ?? 0) - (before ?? 0) };
		})
		.filter((row) => Math.abs(row.delta) >= threshold)
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1));
}

const closureSizes = (closures: Closure[]) =>
	new Map(closures.map((closure) => [closure.key, closure.beyondEntry.gzip]));

const cell = (bytes: number | null) => (bytes === null ? '—' : kb(bytes));

export function renderDelta(input: DeltaInput): { markdown: string; warnings: string[] } {
	const { head, base, budgetBytes } = input;
	const headGzip = head.entry.closure.gzip;
	const headroom = budgetBytes - headGzip;
	const warnings: string[] = [];
	const lines = [
		'### Web entry bundle',
		'',
		`Head \`${short(head.meta.sha)}\`: **${kb(headGzip)} KiB** gzip in ${head.entry.closure.files} files; ` +
			`budget ${kb(budgetBytes)} KiB, headroom **${kb(headroom)} KiB**.`,
	];

	if (headroom < HEADROOM_WARN_BYTES) {
		warnings.push(
			`The web entry closure has ${kb(headroom)} KiB left under its ${kb(budgetBytes)} KiB budget ` +
				`(warning below ${kb(HEADROOM_WARN_BYTES)} KiB). Shrink the boot path in a dedicated pull request; ` +
				'feature pull requests do not raise the budget.'
		);
	}

	if (!base) {
		lines.push(
			'',
			`Base \`${short(input.baseSha)}\`: **no comparison**. ${input.unavailable ?? 'No base report was given.'}`,
			'The delta is unknown, not zero.'
		);
		return { markdown: `${lines.join('\n')}\n`, warnings };
	}

	const delta = headGzip - base.entry.closure.gzip;
	lines.push(
		`Base \`${short(base.meta.sha ?? input.baseSha)}\`: ${kb(base.entry.closure.gzip)} KiB in ` +
			`${base.entry.closure.files} files. **Delta ${signed(delta)} KiB**.`
	);
	if (base.meta.toolchain !== head.meta.toolchain) {
		lines.push(
			'',
			`The two builds used different toolchains (base \`${base.meta.toolchain ?? 'unknown'}\`, ` +
				`head \`${head.meta.toolchain ?? 'unknown'}\`), so part of the delta may be the toolchain's.`
		);
	}
	if (delta >= ENTRY_GROWTH_WARN_BYTES) {
		warnings.push(
			`The web entry closure grew by ${kb(delta)} KiB against the base commit. Say in the pull request ` +
				'what now loads on every page and why it cannot load later.'
		);
	}

	// A report from before the chunk rows existed would list every chunk as new.
	const comparableChunks = Boolean(head.entry.chunks && base.entry.chunks);
	const chunkRows = comparableChunks
		? moves(chunkSizes(head), chunkSizes(base), CHUNK_MOVE_BYTES).slice(0, MAX_ROWS)
		: [];
	if (!comparableChunks) {
		lines.push('', 'Entry chunks: not compared, one of the reports has no chunk rows.');
	} else if (chunkRows.length > 0) {
		lines.push('', '| Entry chunk | Base KiB | Head KiB | Delta |', '|---|---:|---:|---:|');
		for (const row of chunkRows) {
			lines.push(
				`| \`${row.key}\` | ${cell(row.base)} | ${cell(row.head)} | ${signed(row.delta)} |`
			);
		}
	}

	const closureRows = [
		...moves(closureSizes(head.routes), closureSizes(base.routes), CLOSURE_MOVE_BYTES).map(
			(row) => ({ ...row, kind: 'route' })
		),
		...moves(closureSizes(head.deferred), closureSizes(base.deferred), CLOSURE_MOVE_BYTES).map(
			(row) => ({ ...row, kind: 'deferred' })
		),
	]
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1))
		.slice(0, MAX_ROWS);
	if (closureRows.length > 0) {
		lines.push(
			'',
			'Route and deferred closures beyond the entry that moved by 1 KiB or more:',
			'',
			'| Closure | Base KiB | Head KiB | Delta |',
			'|---|---:|---:|---:|'
		);
		for (const row of closureRows) {
			lines.push(
				`| ${row.kind} \`${row.key}\` | ${cell(row.base)} | ${cell(row.head)} | ${signed(row.delta)} |`
			);
		}
	}

	return { markdown: `${lines.join('\n')}\n`, warnings };
}

function readReport(path: string): BundleReport {
	try {
		const report = JSON.parse(readFileSync(path, 'utf8')) as BundleReport;
		if (typeof report?.entry?.closure?.gzip !== 'number') throw new Error('no entry closure');
		return report;
	} catch (error) {
		console.error(`${TOOL}: cannot read the report ${path}: ${(error as Error).message}`);
		process.exit(2);
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		if (index === -1) return null;
		const value = args[index + 1] ?? null;
		args.splice(index, 2);
		return value;
	};
	const baseSha = option('--base-sha');
	let unavailable = option('--unavailable');
	const [headPath, basePath] = args;
	if (!headPath) {
		console.error(
			`Usage: bun scripts/${TOOL}.ts <head.json> [<base.json>] [--base-sha <sha>] [--unavailable <why>]`
		);
		process.exit(2);
	}
	let base: BundleReport | null = null;
	if (basePath && existsSync(basePath)) base = readReport(basePath);
	else if (basePath) unavailable ??= `The base report ${basePath} does not exist.`;

	const { markdown, warnings } = renderDelta({
		head: readReport(headPath),
		base,
		baseSha,
		unavailable,
		budgetBytes: GZIP_BUDGET_KB * 1024,
	});
	console.info(markdown);
	for (const warning of warnings) console.info(`::warning title=Web entry bundle::${warning}`);
	const summary = process.env['GITHUB_STEP_SUMMARY'];
	if (summary) appendFileSync(summary, `${markdown}\n`);
}
