/**
 * The rules behind `lint:comment-policy` (scripts/check-comment-policy.ts) and
 * the comment extraction they run on.
 *
 * A comment says why the code is the way it is: a constraint, an external
 * quirk, an invariant the code cannot show. What changed and when belongs in
 * the PR and CHANGELOG.md, and a tag that indexes into a document the
 * repository does not hold tells the reader nothing. The rules below catch the
 * shapes of both that are cheap to recognise; they are not a style guide.
 *
 * Comments are found by parsing, not by matching `//` on a line: TypeScript's
 * scanner for script files and `<script>` blocks, `<!-- -->` in a Vue template,
 * `/* *\/` in a `<style>` block, and `#` comments in shell and YAML. Strings,
 * template literals and regular expressions are never read as comments.
 */
import ts from 'typescript';
import { parse } from 'vue/compiler-sfc';

type CommentRule = 'issue-reference' | 'narration' | 'dangling-document' | 'decision-tag';

interface RuleHit {
	readonly rule: CommentRule;
	readonly match: string;
}

/** One line of comment text (or of a test title) and the 1-based line it is on. */
export interface TextPiece {
	readonly line: number;
	readonly text: string;
	/** A test title is checked for document tags only; narration there is product wording. */
	readonly kind: 'comment' | 'test-title';
}

export const RULE_ADVICE: Record<CommentRule, string> = {
	'issue-reference':
		'an issue or PR number is history; say what the code must do and leave the link to the PR',
	narration:
		'narration of what the code used to do is history; state the constraint as it holds now',
	'dangling-document':
		'the spec or plan this cites is not in the repository; write the rule out in words',
	'decision-tag':
		'decision tags indexed the removed ADRs and plans; write the decision out in words',
};

/**
 * `#1234`, an issue or pull request number. Not `#000`/`#333` (shorthand
 * colours), a leading zero, `&#123;` or `page#12` (no boundary before `#`), and
 * not one digit, which reads as an ordinal ("attempt #2"). Issue numbers here
 * have two to five digits.
 */
const ISSUE_REFERENCE = /(?<![\w&#/.?=-])#([1-9]\d{1,4})(?![\w-])/g;
/** The quarantine form CLAUDE.md requires above a skipped test. */
const QUARANTINE = /quarantine:\s*#\d+/gi;
const REPEATED_DIGITS = /^(\d)\1\1$/;

/**
 * Phrases that only make sense against an earlier version of the code. Kept
 * narrow on purpose: "the previously focused element" describes runtime state,
 * so `previously` counts only where it opens a sentence or a clause.
 */
const NARRATION = [
	/\buntil now\b/i,
	/(?:^|[.;:!?(\-*/]\s*|—\s*)Previously\b/,
	/\bpreviously,/i,
	/\bformerly\b/i,
	/\bthis (?:PR|pull request|commit)\b/i,
	/\b(?:before|after) this (?:change|fix|PR|commit|refactor)\b/i,
	/\bused to (?:be|do|live|run|return|throw|call|read|write|send|store|keep|have|use|fail|pass)\b/i,
];

/**
 * `SPEC §4.2`, `INBOX_ZERO_PLAN §2`, `plan §06`: sections of specs and plans that
 * are not in the repository. A section of a document that is (`RFC 5321 §4.5`,
 * `CONVENTIONS.md §3`) is a real reference and does not match.
 */
const DANGLING_DOCUMENT =
	/\b(?:SPEC|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_PLAN|[Pp]lan(?:'s)?|[Cc]ontract(?:'s)?)\s*§/g;

/**
 * `D13`, `(D1)`, `ADR-0040`: tags into the removed ADR series and plan
 * documents. A `D` that is part of a longer word (`0xD1`, `ID12`) is not one.
 */
const DECISION_TAG =
	/(?<![\w$.-]|[0-9A-F]{2} )(?:D[1-9]\d?|ADRs?[- ]?\d{1,4})(?![\w$]|\.\d| [0-9A-F]{2}\b)/g;

/** Every rule hit in one line of comment text or test title. */
export function ruleHits(piece: Pick<TextPiece, 'text' | 'kind'>): RuleHit[] {
	const hits: RuleHit[] = [];
	const text = piece.text;
	if (piece.kind === 'comment') {
		const quarantined = text.replace(QUARANTINE, (match) => ' '.repeat(match.length));
		for (const match of quarantined.matchAll(ISSUE_REFERENCE)) {
			if (!REPEATED_DIGITS.test(match[1]!)) hits.push({ rule: 'issue-reference', match: match[0] });
		}
		for (const pattern of NARRATION) {
			const match = pattern.exec(text);
			if (match) hits.push({ rule: 'narration', match: match[0].replace(/^[^A-Za-z]+/, '') });
		}
	}
	for (const match of text.matchAll(DANGLING_DOCUMENT)) {
		hits.push({ rule: 'dangling-document', match: match[0] });
	}
	for (const match of text.matchAll(DECISION_TAG)) {
		hits.push({ rule: 'decision-tag', match: match[0] });
	}
	return hits;
}

/** Split `text` (starting on 1-based `line`) into one piece per line. */
function piecesOf(text: string, line: number, kind: TextPiece['kind']): TextPiece[] {
	return text.split('\n').map((part, index) => ({ line: line + index, text: part, kind }));
}

const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'suite', 'bench']);

/** `it`, `describe.each(rows)`, `it.skipIf(x)`: the test function a call goes back to. */
function testFunctionOf(callee: ts.Expression): string | undefined {
	let current: ts.Expression = callee;
	for (;;) {
		if (ts.isIdentifier(current))
			return TEST_FUNCTIONS.has(current.text) ? current.text : undefined;
		if (ts.isPropertyAccessExpression(current)) current = current.expression;
		else if (ts.isCallExpression(current)) current = current.expression;
		else return undefined;
	}
}

/**
 * Comment lines and test titles of a script. `firstLine` is the 1-based line
 * of the file that `text` starts on (a `<script>` block's offset).
 */
export function scriptPieces(text: string, kind: ts.ScriptKind, firstLine = 1): TextPiece[] {
	const source = ts.createSourceFile('file', text, ts.ScriptTarget.Latest, true, kind);
	const lineOf = (position: number) =>
		source.getLineAndCharacterOfPosition(position).line + firstLine;
	const pieces: TextPiece[] = [];
	const commentStarts = new Set<number>();
	const jsxText: [number, number][] = [];
	const ranges: ts.CommentRange[] = [];
	const visit = (node: ts.Node) => {
		if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
			return;
		if (node.kind === ts.SyntaxKind.JsxText) {
			jsxText.push([node.pos, node.end]);
			return;
		}
		ranges.push(...(ts.getLeadingCommentRanges(text, node.pos) ?? []));
		ranges.push(...(ts.getTrailingCommentRanges(text, node.end) ?? []));
		if (ts.isCallExpression(node) && testFunctionOf(node.expression)) {
			const [title] = node.arguments;
			if (title && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) {
				const start = title.getStart(source);
				pieces.push(...piecesOf(title.getText(source), lineOf(start), 'test-title'));
			}
		}
		for (const child of node.getChildren(source)) visit(child);
	};
	visit(source);
	for (const range of ranges) {
		// Text inside JSX (`<p>// not a comment</p>`) is scanned as trivia by
		// the comment-range helpers; it is copy, not a comment.
		if (commentStarts.has(range.pos)) continue;
		if (jsxText.some(([start, end]) => range.pos >= start && range.pos < end)) continue;
		commentStarts.add(range.pos);
		pieces.push(...piecesOf(text.slice(range.pos, range.end), lineOf(range.pos), 'comment'));
	}
	return pieces;
}

/** The `#` comment on each line of a shell script or YAML file. */
export function hashCommentPieces(text: string): TextPiece[] {
	const pieces: TextPiece[] = [];
	const lines = text.split('\n');
	for (const [index, line] of lines.entries()) {
		if (index === 0 && line.startsWith('#!')) continue;
		let quote: string | undefined;
		for (let column = 0; column < line.length; column += 1) {
			const char = line[column]!;
			if (quote) {
				if (char === '\\' && quote === '"') column += 1;
				else if (char === quote) quote = undefined;
			} else if (char === '\\') column += 1;
			else if (char === '"' || char === "'") quote = char;
			else if (char === '#' && (column === 0 || /\s/.test(line[column - 1]!))) {
				pieces.push({ line: index + 1, text: line.slice(column), kind: 'comment' });
				break;
			}
		}
	}
	return pieces;
}

function scriptKindOf(lang: string | undefined): ts.ScriptKind {
	if (lang === 'tsx') return ts.ScriptKind.TSX;
	if (lang === 'jsx') return ts.ScriptKind.JSX;
	if (lang === 'ts') return ts.ScriptKind.TS;
	return ts.ScriptKind.JS;
}

/** Matches of `pattern` in a block, as pieces on the file's lines. */
function blockMatches(content: string, firstLine: number, pattern: RegExp): TextPiece[] {
	const pieces: TextPiece[] = [];
	for (const match of content.matchAll(pattern)) {
		const line = firstLine + content.slice(0, match.index).split('\n').length - 1;
		pieces.push(...piecesOf(match[0], line, 'comment'));
	}
	return pieces;
}

/** Comment lines and test titles of a single-file component; undefined if it does not parse. */
export function vuePieces(text: string): TextPiece[] | undefined {
	const { descriptor, errors } = parse(text, { filename: 'file.vue' });
	if (errors.length > 0) return undefined;
	const pieces: TextPiece[] = [];
	for (const block of [descriptor.script, descriptor.scriptSetup]) {
		if (block)
			pieces.push(...scriptPieces(block.content, scriptKindOf(block.lang), block.loc.start.line));
	}
	const { template } = descriptor;
	if (template)
		pieces.push(...blockMatches(template.content, template.loc.start.line, /<!--[\s\S]*?-->/g));
	for (const style of descriptor.styles) {
		pieces.push(...blockMatches(style.content, style.loc.start.line, /\/\*[\s\S]*?\*\//g));
	}
	return pieces;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
	ts: ts.ScriptKind.TS,
	mts: ts.ScriptKind.TS,
	cts: ts.ScriptKind.TS,
	tsx: ts.ScriptKind.TSX,
	js: ts.ScriptKind.JS,
	mjs: ts.ScriptKind.JS,
	cjs: ts.ScriptKind.JS,
	jsx: ts.ScriptKind.JSX,
};
const HASH_COMMENT_EXTENSIONS = new Set(['sh', 'bash', 'yml', 'yaml']);

/** Whether the gate reads a file of this path at all. */
export function isCheckedPath(path: string): boolean {
	if (/(^|\/)_generated\//.test(path)) return false;
	const extension = /\.([^./]+)$/.exec(path)?.[1] ?? '';
	return extension in SCRIPT_KINDS || extension === 'vue' || HASH_COMMENT_EXTENSIONS.has(extension);
}

/**
 * The comment lines and test titles of a file, by its extension; undefined
 * when the gate does not read this kind of file or cannot parse it.
 */
export function piecesOfFile(path: string, text: string): TextPiece[] | undefined {
	if (!isCheckedPath(path)) return undefined;
	const extension = /\.([^./]+)$/.exec(path)![1]!;
	if (extension === 'vue') return vuePieces(text);
	if (HASH_COMMENT_EXTENSIONS.has(extension)) return hashCommentPieces(text);
	return scriptPieces(text, SCRIPT_KINDS[extension]!);
}
