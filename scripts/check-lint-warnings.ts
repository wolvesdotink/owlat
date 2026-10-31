/**
 * Zero-warning lint gate: oxlint over every workspace with `--deny-warnings`,
 * failing on any error and on any warning. The one exception is a warning from
 * an `owlat/*` rule: a rule that lands with debt is configured as a warning and
 * scripts/check-owlat-lint.sh owns it against its own baseline, so counting it
 * here too would give each finding two owners.
 *
 * Fails closed: a crashed or killed oxlint, an exit status other than 0 or 1,
 * a report that does not parse, or an exit 1 with nothing reported (oxlint
 * failed without saying why) all fail, so no tool failure reads as a clean run.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonShapeError } from './json';
import { isOwlatWarning, type LintDiagnostic, parseLintReport } from './lint-diagnostics';

/** The parts of a finished oxlint process the verdict depends on. */
export interface LintRun {
	error?: Error;
	signal: NodeJS.Signals | null;
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface LintVerdict {
	ok: boolean;
	/** One line per finding or failure, for stderr. */
	problems: string[];
}

const formatDiagnostic = (diagnostic: LintDiagnostic): string => {
	const line = diagnostic.labels?.[0]?.span.line;
	const at = line === undefined ? diagnostic.filename : `${diagnostic.filename}:${line}`;
	return `${at}: ${diagnostic.severity} ${diagnostic.code ?? '(oxlint)'}: ${diagnostic.message}`;
};

export function lintVerdict(run: LintRun): LintVerdict {
	// oxlint exits 1 when it reports anything under --deny-warnings; any other
	// outcome means it did not finish linting.
	if (run.error || run.signal || (run.status !== 0 && run.status !== 1)) {
		const reason = run.error?.message ?? run.signal ?? `exit status ${run.status}`;
		return { ok: false, problems: [`oxlint did not finish (${reason}): ${run.stderr.trim()}`] };
	}
	let diagnostics: LintDiagnostic[];
	try {
		diagnostics = parseLintReport(run.stdout);
	} catch (error) {
		if (!(error instanceof JsonShapeError)) throw error;
		return { ok: false, problems: [error.message] };
	}
	if (run.status === 1 && diagnostics.length === 0) {
		return {
			ok: false,
			problems: [`oxlint exited 1 without reporting a diagnostic: ${run.stderr.trim()}`],
		};
	}
	// Every error and every warning, except the owlat warnings their own gate owns.
	const problems = diagnostics.filter((d) => !isOwlatWarning(d)).map(formatDiagnostic);
	return { ok: problems.length === 0, problems };
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
	const verdict = lintVerdict(run);
	if (!verdict.ok) {
		for (const problem of verdict.problems) console.error(problem);
		console.error(
			`FAIL: lint must report no errors and no warnings (${verdict.problems.length} problem(s)).`
		);
		return 1;
	}
	console.info('Lint passed with no errors and no warnings.');
	return 0;
}

if (import.meta.main) process.exitCode = main();
