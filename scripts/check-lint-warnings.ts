/**
 * Freeze existing warnings by file, rule, and offending source text. The
 * comparison is exact in both directions: a new or increased warning fails, and
 * so does a baseline entry whose warnings were fixed, so the baseline never
 * holds slack a fixed warning could silently come back into.
 */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeJson, integer, JsonShapeError, recordOf } from './json';
import { type LintDiagnostic, parseLintReport } from './lint-diagnostics';

export function warningKey(diagnostic: LintDiagnostic, source: Buffer): string {
	const span = diagnostic.labels?.[0]?.span;
	const token = span
		? source.subarray(span.offset, span.offset + span.length).toString('utf8')
		: '';
	return JSON.stringify([diagnostic.filename, diagnostic.code, diagnostic.message, token]);
}

/**
 * A warning from an `owlat/*` rule. Those are ratcheted by
 * scripts/check-owlat-lint.sh against their own baseline, so this gate skips
 * them rather than freezing the same findings twice.
 */
export const isOwlatWarning = (diagnostic: Pick<LintDiagnostic, 'code' | 'severity'>): boolean =>
	diagnostic.severity === 'warning' && (diagnostic.code ?? '').startsWith('owlat(');

/** The warnings this gate freezes: every warning except the owlat ones. */
export const ratchetedWarnings = (diagnostics: LintDiagnostic[]): LintDiagnostic[] =>
	diagnostics.filter(
		(diagnostic) => diagnostic.severity === 'warning' && !isOwlatWarning(diagnostic)
	);

export interface WarningDrift {
	/** Keys whose live count exceeds the baseline: fix the new warnings. */
	regressions: string[];
	/** Keys whose baseline exceeds the live count: lower or delete the entry. */
	stale: string[];
}

export function compareWarnings(
	actual: Record<string, number>,
	baseline: Record<string, number>
): WarningDrift {
	const drift: WarningDrift = { regressions: [], stale: [] };
	for (const key of new Set([...Object.keys(actual), ...Object.keys(baseline)])) {
		const count = actual[key] ?? 0;
		const frozen = baseline[key] ?? 0;
		if (count > frozen) drift.regressions.push(`${key}: ${count} warnings (baseline ${frozen})`);
		else if (count < frozen) drift.stale.push(`${key}: ${count} warnings (baseline ${frozen})`);
	}
	return drift;
}

/** The frozen warning counts, by key. */
function readBaseline(root: string): Record<string, number> {
	const path = 'scripts/lint-warning-baseline.json';
	return decodeJson(readFileSync(resolve(root, path), 'utf8'), recordOf(integer), path);
}

function main(): number {
	const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
	const run = spawnSync(
		'bunx',
		[
			'--no-install',
			'oxlint',
			'--config',
			'oxlintrc.json',
			'--format',
			'json',
			'--deny-warnings',
			'apps',
			'packages',
			'scripts',
			'examples',
		],
		{ cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
	);
	if (run.error || run.signal || (run.status !== 0 && run.status !== 1)) {
		console.error(run.error ?? run.stderr ?? 'oxlint failed');
		return 1;
	}
	let diagnostics: LintDiagnostic[];
	let baseline: Record<string, number>;
	try {
		diagnostics = parseLintReport(run.stdout);
		baseline = readBaseline(root);
	} catch (error) {
		if (!(error instanceof JsonShapeError)) throw error;
		console.error(error.message);
		return 1;
	}
	const counts: Record<string, number> = {};
	const errors = diagnostics.filter((d) => d.severity === 'error');
	for (const diagnostic of ratchetedWarnings(diagnostics)) {
		const filename = resolve(root, diagnostic.filename);
		const normalized = { ...diagnostic, filename: relative(root, filename) };
		const key = warningKey(normalized, readFileSync(filename));
		counts[key] = (counts[key] ?? 0) + 1;
	}
	const { regressions, stale } = compareWarnings(counts, baseline);
	for (const error of errors) console.error(`${error.filename}: ${error.code}: ${error.message}`);
	if (regressions.length) {
		console.error(`FAIL: ${regressions.length} warning key(s) above the baseline:`);
		for (const line of regressions) console.error(`  ${line}`);
		console.error('Fix these warnings. Do not raise scripts/lint-warning-baseline.json.');
	}
	if (stale.length) {
		console.error(`FAIL: ${stale.length} stale key(s) in scripts/lint-warning-baseline.json:`);
		for (const line of stale) console.error(`  ${line}`);
		console.error(
			'These warnings were fixed. Lower each count to the live one, or delete the key at 0.'
		);
	}
	if (errors.length || regressions.length || stale.length) return 1;
	console.info(
		`Lint warning ratchet passed (${Object.values(counts).reduce((a, b) => a + b, 0)} grandfathered warnings).`
	);
	return 0;
}

if (import.meta.main) process.exitCode = main();
