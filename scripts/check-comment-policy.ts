/**
 * `lint:comment-policy`: the comment rules of CLAUDE.md ("Comments"), checked
 * on every comment of every file the rules cover. The rules and the comment
 * extraction are in scripts/comment-policy.ts.
 *
 * The scan reads the whole working tree: tracked files as they are on disk,
 * plus untracked files git does not ignore, so a new file counts before it is
 * staged. It reads every line, not only the lines a change adds, so a change to
 * the rules applies to the comments already in the tree, and a run never needs
 * a base commit or the history behind one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** Rule hits on every comment line and test title of one file. */
export function findingsInFile(path: string, text: string): CommentFinding[] | undefined {
	const pieces = piecesOfFile(path, text);
	if (!pieces) return undefined;
	const findings: CommentFinding[] = [];
	for (const piece of pieces)
		for (const hit of ruleHits(piece)) findings.push({ path, line: piece.line, ...hit });
	return findings;
}

export interface GateResult {
	readonly status: number;
	readonly findings: readonly CommentFinding[];
	/** What the run prints, one entry per line. */
	readonly messages: readonly string[];
}

/** The gate against the working tree of the checkout at `root`. */
export function checkCommentPolicy(root: string): GateResult {
	const messages: string[] = [];
	const listed = spawnSync(
		'git',
		[
			'-c',
			'core.quotePath=false',
			'ls-files',
			'-z',
			'--cached',
			'--others',
			'--exclude-standard',
			'--',
			...PATHSPECS,
		],
		{ cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 }
	);
	if (listed.status !== 0) {
		messages.push(`check-comment-policy: git ls-files failed: ${listed.stderr.trim()}`);
		return { status: 1, findings: [], messages };
	}

	const findings: CommentFinding[] = [];
	let checked = 0;
	for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
		if (EXEMPT_PATHS.has(path) || !isCheckedPath(path)) continue;
		// A tracked file deleted from the working tree is still listed by --cached.
		const absolute = join(root, path);
		if (!existsSync(absolute)) continue;
		const found = findingsInFile(path, readFileSync(absolute, 'utf8'));
		if (!found) {
			messages.push(`check-comment-policy: ${path} does not parse; its comments were not checked.`);
			continue;
		}
		checked += 1;
		findings.push(...found);
	}
	if (findings.length === 0) {
		messages.push(`check-comment-policy: ${checked} file(s), ok.`);
		return { status: 0, findings, messages };
	}
	for (const finding of findings) {
		messages.push(
			`${finding.path}:${finding.line}: ${finding.rule}: "${finding.match}" — ${RULE_ADVICE[finding.rule]}`
		);
	}
	messages.push(
		`check-comment-policy: ${findings.length} finding(s) in ${checked} file(s). ` +
			'Comments say why the code is the way it is; history goes in the PR (CLAUDE.md, "Comments").'
	);
	return { status: 1, findings, messages };
}

if (import.meta.main) {
	const result = checkCommentPolicy(join(import.meta.dirname, '..'));
	(result.status === 0 ? process.stdout : process.stderr).write(`${result.messages.join('\n')}\n`);
	process.exit(result.status);
}
