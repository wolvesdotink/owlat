/**
 * Shared fixtures for the Semgrep coverage check tests
 * (`scripts/check-semgrep-timeouts.sh`): reports shaped like Semgrep 1.178's
 * `--time --json-output`, a runner for the real script, a stand-in
 * `semgrep` for `--scan` mode, and a model of how the Actions runner reads
 * workflow commands from a step's output.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPOSITORY_ROOT, 'scripts/check-semgrep-timeouts.sh');
const run = promisify(execFile);

const roots: string[] = [];

export async function cleanup(): Promise<void> {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
}

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-semgrep-check-'));
	roots.push(root);
	return root;
}

export function fixpointTimeout(
	path: string,
	line: number,
	col: number,
	rules: number,
	first: string
): Record<string, unknown> {
	return {
		error_type: 'Fixpoint timeout',
		severity: 'warn',
		message: `Fixpoint timeout while performing taint analysis at ${path}:${line}:${col} [rules: ${rules}, first: ${first}]`,
		location: {
			path,
			start: { line, col: col + 1, offset: 0 },
			end: { line, col: col + 1, offset: 0 },
		},
	};
}

export const RULE_PARSE_ERROR = {
	code: 2,
	level: 'error',
	type: 'Rule parse error',
	rule_id: 'webhook-signature-presence-only',
	message:
		'Rule parse error in rule webhook-signature-presence-only:\n Invalid pattern for TypeScript: Stdlib.Parsing.Parse_error\n----- pattern -----\n$X = $FN(...) {\n}\n',
};

export const PARTIAL_PARSING = {
	code: 3,
	level: 'warn',
	type: [
		'PartialParsing',
		[{ path: 'apps/api/convex/mail/outboundCron.ts', start: { line: 63, col: 1, offset: 0 } }],
	],
	message:
		"Syntax error at line apps/api/convex/mail/outboundCron.ts:63:\n `import('x')` was unexpected",
	path: 'apps/api/convex/mail/outboundCron.ts',
};

export function report({
	timeouts = [] as unknown[],
	errors = [] as unknown[],
}: { timeouts?: unknown[]; errors?: unknown[] } = {}): string {
	return JSON.stringify({
		results: [],
		errors,
		paths: { scanned: [] },
		time: { fixpoint_timeouts: timeouts, targets: [], total_bytes: 0, max_memory_bytes: 0 },
	});
}

interface ParsedCommand {
	name: string;
	data: string;
}

/**
 * The runner's two command parsers (actions/runner ActionCommand.cs):
 * `::name props::data` after leading whitespace is trimmed, and the legacy
 * `##[name props]data` anywhere in the line. Every command name counts here;
 * the real runner only knows registered ones, so this is stricter.
 */
function parseCommand(line: string): ParsedCommand | null {
	const trimmed = line.trimStart();
	if (trimmed.startsWith('::')) {
		const end = trimmed.indexOf('::', 2);
		if (end >= 0) {
			return { name: trimmed.slice(2, end).split(' ')[0] ?? '', data: trimmed.slice(end + 2) };
		}
	}
	const prefix = line.indexOf('##[');
	if (prefix >= 0) {
		const close = line.indexOf(']', prefix);
		if (close >= 0) {
			return {
				name: line.slice(prefix + 3, close).split(' ')[0] ?? '',
				data: line.slice(close + 1),
			};
		}
	}
	return null;
}

/**
 * The commands the runner would act on, in order, following
 * ActionCommandManager.TryProcessCommand: after `stop-commands` only the
 * matching resume token is processed. Stop and resume lines are left out.
 */
export function runnerCommands(stdout: string): string[] {
	const acted: string[] = [];
	let stopToken: string | null = null;
	for (const line of stdout.split('\n')) {
		const command = parseCommand(line);
		if (command === null) continue;
		if (stopToken !== null) {
			if (command.name.toLowerCase() === stopToken.toLowerCase()) stopToken = null;
			continue;
		}
		if (command.name === 'stop-commands') {
			stopToken = command.data;
			continue;
		}
		acted.push(line);
	}
	return acted;
}

/**
 * Splits the output at the script's stop/resume pairs: `inside` holds the
 * lines printed while commands were suspended, `outside` the rest, and
 * `tokens` each pair's token. Throws on an unpaired or mismatched marker.
 */
export function suspendedBlocks(stdout: string): {
	inside: string[];
	outside: string[];
	tokens: string[];
} {
	const inside: string[] = [];
	const outside: string[] = [];
	const tokens: string[] = [];
	let token: string | null = null;
	for (const line of stdout.split('\n')) {
		if (token === null) {
			const stop = /^::stop-commands::(.+)$/.exec(line);
			if (stop) {
				token = stop[1] ?? '';
				tokens.push(token);
			} else outside.push(line);
		} else if (line === `::${token}::`) token = null;
		else inside.push(line);
	}
	if (token !== null) throw new Error(`stop-commands ${token} was never resumed`);
	return { inside, outside, tokens };
}

export interface Outcome {
	code: number;
	stdout: string;
	summary: string;
}

async function invoke(root: string, args: string[], summary: boolean): Promise<Outcome> {
	const summaryPath = join(root, 'summary.md');
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env['GITHUB_STEP_SUMMARY'];
	if (summary) env['GITHUB_STEP_SUMMARY'] = summaryPath;
	let code = 0;
	let stdout: string;
	try {
		({ stdout } = await run('bash', [SCRIPT, ...args], { env }));
	} catch (error) {
		const failed = error as { code: number; stdout: string };
		code = failed.code;
		stdout = failed.stdout;
	}
	const written = await readFile(summaryPath, 'utf8').catch(() => '');
	return { code, stdout, summary: written };
}

/** Runs the script on one report (`null`: no report file at all). */
export async function check(
	contents: string | null,
	{ summary = true }: { summary?: boolean } = {}
): Promise<Outcome> {
	const root = await tempRoot();
	const reportPath = join(root, 'semgrep.json');
	if (contents !== null) await writeFile(reportPath, contents, 'utf8');
	return invoke(root, [reportPath], summary);
}

/** What the stand-in semgrep does on one run. */
export interface FakeRun {
	/** Written to the --json-output path; `null` writes nothing. */
	report: string | null;
	exitCode?: number;
	/** Printed to stdout, like Semgrep's text report. */
	stdout?: string;
}

/**
 * Runs `--scan <dir> -- <fake semgrep> scan --error` where the fake semgrep
 * plays `runs` in order. Returns the outcome plus the arguments of each run.
 */
export async function scan(runs: FakeRun[]): Promise<Outcome & { invocations: string[][] }> {
	const root = await tempRoot();
	for (const [i, step] of runs.entries()) {
		if (step.report !== null) await writeFile(join(root, `report.${i + 1}`), step.report, 'utf8');
		await writeFile(join(root, `rc.${i + 1}`), String(step.exitCode ?? 0), 'utf8');
		await writeFile(join(root, `out.${i + 1}`), step.stdout ?? '', 'utf8');
	}
	const fake = join(root, 'semgrep');
	await writeFile(
		fake,
		[
			'#!/usr/bin/env bash',
			`state=${JSON.stringify(root)}`,
			'n=$(( $(cat "$state/count" 2>/dev/null || echo 0) + 1 ))',
			'echo "$n" > "$state/count"',
			'printf "%s\\n" "$@" > "$state/args.$n"',
			'out=""; prev=""',
			'for a in "$@"; do [ "$prev" = --json-output ] && out=$a; prev=$a; done',
			'if [ -f "$state/report.$n" ]; then cp "$state/report.$n" "$out"; fi',
			'cat "$state/out.$n" 2>/dev/null || true',
			'exit "$(cat "$state/rc.$n" 2>/dev/null || echo 0)"',
			'',
		].join('\n'),
		'utf8'
	);
	await chmod(fake, 0o755);
	const outcome = await invoke(root, ['--scan', root, '--', fake, 'scan', '--error'], true);
	const count = Number(await readFile(join(root, 'count'), 'utf8').catch(() => '0'));
	const invocations: string[][] = [];
	for (let n = 1; n <= count; n++) {
		const args = await readFile(join(root, `args.${n}`), 'utf8');
		invocations.push(
			args
				.trimEnd()
				.split('\n')
				.map((arg) => arg.replace(root, '<dir>'))
		);
	}
	return { ...outcome, invocations };
}
