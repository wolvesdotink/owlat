/** Freeze existing warnings by file, rule, and offending source text. New warnings fail CI. */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface LintDiagnostic {
	filename: string;
	code: string;
	message: string;
	severity: string;
	labels?: { span: { offset: number; length: number } }[];
}

export function warningKey(diagnostic: LintDiagnostic, source: Buffer): string {
	const span = diagnostic.labels?.[0]?.span;
	const token = span
		? source.subarray(span.offset, span.offset + span.length).toString('utf8')
		: '';
	return JSON.stringify([diagnostic.filename, diagnostic.code, diagnostic.message, token]);
}

export function excessWarnings(
	actual: Record<string, number>,
	baseline: Record<string, number>
): string[] {
	return Object.entries(actual)
		.filter(([key, count]) => count > (baseline[key] ?? 0))
		.map(([key, count]) => `${key}: ${count} warnings (baseline ${baseline[key] ?? 0})`);
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
	const report = JSON.parse(run.stdout) as { diagnostics: LintDiagnostic[] };
	if (!Array.isArray(report.diagnostics)) throw new Error('Missing oxlint diagnostics');
	const counts: Record<string, number> = {};
	const errors = report.diagnostics.filter((d) => d.severity === 'error');
	for (const diagnostic of report.diagnostics) {
		if (diagnostic.severity !== 'warning') continue;
		const filename = resolve(root, diagnostic.filename);
		const normalized = { ...diagnostic, filename: relative(root, filename) };
		const key = warningKey(normalized, readFileSync(filename));
		counts[key] = (counts[key] ?? 0) + 1;
	}
	const baseline = JSON.parse(
		readFileSync(resolve(root, 'scripts/lint-warning-baseline.json'), 'utf8')
	) as Record<string, number>;
	const failures = excessWarnings(counts, baseline);
	for (const error of errors) console.error(`${error.filename}: ${error.code}: ${error.message}`);
	for (const failure of failures) console.error(failure);
	if (errors.length || failures.length) return 1;
	console.info(
		`Lint warning ratchet passed (${Object.values(counts).reduce((a, b) => a + b, 0)} grandfathered warnings).`
	);
	return 0;
}

if (import.meta.main) process.exitCode = main();
