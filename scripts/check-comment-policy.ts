/**
 * `lint:comment-policy`: the comment rules of CLAUDE.md ("Comments"), checked
 * on the lines a change adds. The rules and the comment extraction are in
 * scripts/comment-policy.ts.
 *
 * Only added and modified lines are read. Existing comments are not
 * grandfathered by a baseline because most of them hold real constraints:
 * deleting them wholesale would lose the reason a maintainer needs, so they
 * are trimmed when someone edits the lines for another reason. A file that is
 * only renamed adds no lines.
 *
 * The change is the diff from the merge base to the working tree, so committed,
 * staged and unstaged edits count, and an untracked file counts whole. The base:
 * - COMMENT_POLICY_BASE when set (`bun run check:changed` sets it to its own
 *   merge base);
 * - a pull request (GITHUB_BASE_REF): its target branch;
 * - otherwise origin/main.
 * A base that cannot be resolved fails in CI (CI=true) and skips locally.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULE_ADVICE, isCheckedPath, piecesOfFile, ruleHits } from './comment-policy';

/** Files that quote the patterns they reject. */
const EXEMPT_PATHS = new Set([
	'scripts/comment-policy.ts',
	'scripts/check-comment-policy.ts',
	'scripts/__tests__/check-comment-policy.test.ts',
]);

const PATHSPECS = [
	'*.ts',
	'*.tsx',
	'*.mts',
	'*.cts',
	'*.js',
	'*.jsx',
	'*.mjs',
	'*.cjs',
	'*.vue',
	'*.sh',
	'*.bash',
	'*.yml',
	'*.yaml',
	':(exclude)**/_generated/**',
];

export interface CommentFinding {
	readonly path: string;
	readonly line: number;
	readonly rule: keyof typeof RULE_ADVICE;
	readonly match: string;
}

/** Undo git's C-style quoting of a path (`"a\tb"`, `"caf\303\251"`). */
export function unquotePath(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	const bytes: number[] = [];
	const escapes: Record<string, number> = {
		n: 10,
		t: 9,
		r: 13,
		'"': 34,
		'\\': 92,
		a: 7,
		b: 8,
		f: 12,
		v: 11,
	};
	for (let index = 1; index < raw.length - 1; index += 1) {
		const char = raw[index]!;
		if (char !== '\\') {
			bytes.push(...Buffer.from(char, 'utf8'));
			continue;
		}
		const next = raw[index + 1]!;
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(raw.slice(index + 1, index + 4), 8));
			index += 3;
		} else {
			bytes.push(escapes[next] ?? next.charCodeAt(0));
			index += 1;
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

/**
 * The added line numbers of each file in a `git diff -U0` (new side). Hunk
 * bodies are skipped by their counts, so an added line that starts with `+++`
 * is never read as a file header.
 */
export function parseChangedLines(diff: string): Map<string, Set<number>> {
	const changed = new Map<string, Set<number>>();
	const lines = diff.split('\n');
	let current: string | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.startsWith('diff --git ')) current = undefined;
		else if (line.startsWith('+++ ')) {
			// Git ends the header with a tab when the path holds a space. A
			// path that holds a tab itself is always quoted, so the tab is never
			// part of the name.
			const target = line.slice(4).replace(/\t$/, '');
			current = target === '/dev/null' ? undefined : unquotePath(target).replace(/^b\//, '');
		} else if (line.startsWith('@@ ')) {
			const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!hunk) continue;
			const removed = Number(hunk[1] ?? 1);
			const start = Number(hunk[2]);
			const added = Number(hunk[3] ?? 1);
			if (current !== undefined && added > 0) {
				const set = changed.get(current) ?? new Set<number>();
				for (let offset = 0; offset < added; offset += 1) set.add(start + offset);
				changed.set(current, set);
			}
			let body = removed + added;
			while (body > 0 && index + 1 < lines.length) {
				index += 1;
				if (!lines[index]!.startsWith('\\')) body -= 1;
			}
		}
	}
	return changed;
}

/** Rule hits on the given lines of one file; every line when `lines` is 'all'. */
export function findingsInFile(
	path: string,
	text: string,
	lines: ReadonlySet<number> | 'all'
): CommentFinding[] | undefined {
	const pieces = piecesOfFile(path, text);
	if (!pieces) return undefined;
	const findings: CommentFinding[] = [];
	for (const piece of pieces) {
		if (lines !== 'all' && !lines.has(piece.line)) continue;
		for (const hit of ruleHits(piece)) findings.push({ path, line: piece.line, ...hit });
	}
	return findings;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
	const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
	});
	return { ok: result.status === 0, out: result.stdout };
}

function resolveBase(
	root: string,
	env: NodeJS.ProcessEnv
): { label: string; commit: string | undefined } {
	const mergeBase = (ref: string) => {
		const result = git(root, ['merge-base', ref, 'HEAD']);
		return result.ok ? result.out.trim() : undefined;
	};
	const explicit = env['COMMENT_POLICY_BASE'];
	if (explicit) return { label: explicit, commit: mergeBase(explicit) };
	const target = env['GITHUB_BASE_REF'];
	if (target) {
		git(root, [
			'fetch',
			'--quiet',
			'--no-tags',
			'origin',
			`+refs/heads/${target}:refs/remotes/origin/${target}`,
		]);
		return { label: `origin/${target}`, commit: mergeBase(`origin/${target}`) };
	}
	return { label: 'origin/main', commit: mergeBase('origin/main') };
}

export interface GateResult {
	readonly status: number;
	readonly findings: readonly CommentFinding[];
	/** What the run prints, one entry per line. */
	readonly messages: readonly string[];
}

/** The gate against the checkout at `root`, with the base taken from `env`. */
export function checkCommentPolicy(root: string, env: NodeJS.ProcessEnv): GateResult {
	const messages: string[] = [];
	const { label, commit } = resolveBase(root, env);
	if (!commit) {
		const message = `check-comment-policy: cannot resolve the base ${label}`;
		if (env['CI'] === 'true') {
			messages.push(`${message}; fetch the history (fetch-depth: 0) or set COMMENT_POLICY_BASE.`);
			return { status: 1, findings: [], messages };
		}
		messages.push(`${message}; skipping outside CI.`);
		return { status: 0, findings: [], messages };
	}
	const diff = git(root, [
		'diff',
		'-U0',
		'-M',
		'--no-color',
		'--no-ext-diff',
		'--src-prefix=a/',
		'--dst-prefix=b/',
		commit,
		'--',
		...PATHSPECS,
	]);
	if (!diff.ok) {
		messages.push(`check-comment-policy: git diff against ${label} failed.`);
		return { status: 1, findings: [], messages };
	}
	const changed = parseChangedLines(diff.out);
	const untracked = git(root, [
		'ls-files',
		'-z',
		'--others',
		'--exclude-standard',
		'--',
		...PATHSPECS,
	]);
	const whole = new Set(untracked.out.split('\0').filter(Boolean));

	const findings: CommentFinding[] = [];
	let checked = 0;
	for (const path of [...changed.keys(), ...whole]) {
		if (EXEMPT_PATHS.has(path) || !isCheckedPath(path)) continue;
		const text = readFileSync(join(root, path), 'utf8');
		const found = findingsInFile(path, text, whole.has(path) ? 'all' : changed.get(path)!);
		if (!found) {
			messages.push(`check-comment-policy: ${path} does not parse; its comments were not checked.`);
			continue;
		}
		checked += 1;
		findings.push(...found);
	}
	if (findings.length === 0) {
		messages.push(`check-comment-policy: ${checked} changed file(s) against ${label}, ok.`);
		return { status: 0, findings, messages };
	}
	for (const finding of findings) {
		messages.push(
			`${finding.path}:${finding.line}: ${finding.rule}: "${finding.match}" — ${RULE_ADVICE[finding.rule]}`
		);
	}
	messages.push(
		`check-comment-policy: ${findings.length} finding(s) in lines changed against ${label}. ` +
			'Comments say why the code is the way it is; history goes in the PR (CLAUDE.md, "Comments").'
	);
	return { status: 1, findings, messages };
}

if (import.meta.main) {
	const result = checkCommentPolicy(join(import.meta.dirname, '..'), process.env);
	(result.status === 0 ? process.stdout : process.stderr).write(`${result.messages.join('\n')}\n`);
	process.exit(result.status);
}
