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
 * scanner for script files and `<script>` blocks, the comment nodes of a Vue
 * template, a quote-aware scan of `<style>` blocks, the YAML parser's comment
 * tokens, and a shell scan that follows quoting and here-documents. Strings,
 * template literals, regular expressions, interpolations, attribute values,
 * here-document bodies and YAML scalars are data, never comments.
 */
import ts from 'typescript';
import { NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-core';
import { parse } from 'vue/compiler-sfc';
import { Parser as YamlParser } from 'yaml';

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
	/**
	 * The comment line directly above when this line continues it, so a
	 * sentence wrapped onto this line is not read as opening here.
	 */
	readonly previous?: string;
	/**
	 * The comment this line belongs to: lines that share it are one comment,
	 * read as one text for phrases that wrap (see `wrappedNarrationHits`).
	 */
	readonly comment?: number;
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
 * so `previously` counts only where it opens a sentence or a clause (see
 * `opensWithPreviously`).
 */
const NARRATION = [
	/\buntil now\b/i,
	/\bformerly\b/i,
	/\bthis (?:PR|pull request|commit)\b/i,
	/\b(?:before|after) this (?:change|fix|PR|commit|refactor)\b/i,
	/\bused to (?:be|do|live|run|return|throw|call|read|write|send|store|keep|have|use|fail|pass)\b/i,
];
const NARRATION_ANYWHERE = NARRATION.map((pattern) => new RegExp(pattern.source, 'gi'));

/**
 * `SPEC §4.2`, `INBOX_ZERO_PLAN §2`, `plan §06`: sections of specs and plans that
 * are not in the repository. A section of a document that is (`RFC 5321 §4.5`,
 * `CONVENTIONS.md §3`) is a real reference and does not match.
 */
const DANGLING_DOCUMENT =
	/\b(?:SPEC|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_PLAN|[Pp]lan(?:'s)?|[Cc]ontract(?:'s)?)\s*§/g;

/**
 * `D13`, `(D1)`, `pre-D8`, `ADR-0040`: tags into the removed ADR series and
 * plan documents. A `D` that is part of a longer word (`0xD1`, `ID12`, `D3.js`,
 * `D1.5`), a flag (`-D1`), a percent-escape (`%D1%80`) or a hex dump
 * (`FF D8 FF`) is not one.
 */
const DECISION_TAG =
	/(?<![\w$.%]|(?:^|[^a-z])-|[0-9A-F]{2} )(?:D[1-9]\d?|ADRs?[- ]?\d{1,4})(?![\w$]|\.\w| [0-9A-F]{2}\b)/g;

/** A comment line without its delimiters (`//`, `/*`, ` * `, `#`, `<!--`) and list bullet. */
function commentBody(text: string): string {
	return text
		.replace(/^\s*(?:\/\/+|\/\*+|\*+(?!\/)|#+|<!--)?\s*(?:[-–•]\s+)?/, '')
		.replace(/\s*(?:\*\/|-->)\s*$/, '');
}

/** "previously" after a clause boundary, or followed by a comma ("Previously, ..."). */
const PREVIOUSLY_IN_LINE = /(?:[.;:!?(]|\s[-–]|—)\s*previously\b|\bpreviously,/i;

/**
 * Whether the line opens with "previously". Capitalised it opens a sentence
 * wherever it stands; in lower case it does unless the line above is the same
 * comment with its sentence still running ("restore the" / "previously focused
 * element").
 */
function opensWithPreviously(piece: Pick<TextPiece, 'text' | 'previous'>): string | undefined {
	const match = /^previously\b/i.exec(commentBody(piece.text));
	if (!match) return undefined;
	if (match[0] === 'Previously' || piece.previous === undefined) return match[0];
	const above = commentBody(piece.previous).trimEnd();
	return above === '' || /[.;:!?]$/.test(above) ? match[0] : undefined;
}

/**
 * Narration phrases that wrap from one line of a comment onto the next, each
 * reported on the line the phrase starts on. A phrase inside one line is
 * `ruleHits`' to report. An empty comment line ends a paragraph, so a phrase
 * does not run across it.
 */
export function wrappedNarrationHits(
	pieces: readonly TextPiece[]
): { readonly line: number; readonly hit: RuleHit }[] {
	const comments = new Map<number, TextPiece[]>();
	for (const piece of pieces) {
		if (piece.kind !== 'comment' || piece.comment === undefined) continue;
		const lines = comments.get(piece.comment);
		if (lines) lines.push(piece);
		else comments.set(piece.comment, [piece]);
	}
	const hits: { line: number; hit: RuleHit }[] = [];
	for (const lines of comments.values()) {
		for (const paragraph of paragraphsOf(lines)) {
			if (paragraph.length < 2) continue;
			let joined = '';
			const starts: number[] = [];
			for (const { body } of paragraph) {
				if (joined) joined += ' ';
				starts.push(joined.length);
				joined += body;
			}
			const lineAt = (offset: number) => starts.findLastIndex((start) => start <= offset);
			for (const pattern of NARRATION_ANYWHERE) {
				for (const match of joined.matchAll(pattern)) {
					const first = lineAt(match.index);
					if (first === lineAt(match.index + match[0].length - 1)) continue;
					hits.push({ line: paragraph[first]!.line, hit: { rule: 'narration', match: match[0] } });
				}
			}
		}
	}
	return hits;
}

/** The lines of one comment as runs of non-empty bodies. */
function paragraphsOf(lines: readonly TextPiece[]): { line: number; body: string }[][] {
	const paragraphs: { line: number; body: string }[][] = [[]];
	for (const piece of lines.toSorted((a, b) => a.line - b.line)) {
		const body = commentBody(piece.text).trim();
		if (body) paragraphs.at(-1)!.push({ line: piece.line, body });
		else paragraphs.push([]);
	}
	return paragraphs;
}

/** Every rule hit in one line of comment text or test title. */
export function ruleHits(piece: Pick<TextPiece, 'text' | 'kind' | 'previous'>): RuleHit[] {
	const hits: RuleHit[] = [];
	const text = piece.text;
	if (piece.kind === 'comment') {
		const quarantined = text.replace(QUARANTINE, (match) => ' '.repeat(match.length));
		for (const match of quarantined.matchAll(ISSUE_REFERENCE)) {
			if (!REPEATED_DIGITS.test(match[1]!)) hits.push({ rule: 'issue-reference', match: match[0] });
		}
		for (const pattern of NARRATION) {
			const match = pattern.exec(text);
			if (match) hits.push({ rule: 'narration', match: match[0] });
		}
		const previously =
			opensWithPreviously(piece) ??
			/previously/i.exec(PREVIOUSLY_IN_LINE.exec(text)?.[0] ?? '')?.[0];
		if (previously) hits.push({ rule: 'narration', match: previously });
	}
	for (const match of text.matchAll(DANGLING_DOCUMENT)) {
		hits.push({ rule: 'dangling-document', match: match[0] });
	}
	for (const match of text.matchAll(DECISION_TAG)) {
		hits.push({ rule: 'decision-tag', match: match[0] });
	}
	return hits;
}

let lastCommentId = 0;

/** A fresh comment id, unique across every file kind a run reads. */
function newCommentId(): number {
	lastCommentId += 1;
	return lastCommentId;
}

/**
 * Ids for the line comments (`//`, `#`) of one scan, taken in line order. A
 * line comment that stands alone on its line continues the one alone on the
 * line above: a paragraph written as a run of `//` lines is one comment. A
 * comment after code on its line starts a comment of its own and continues
 * none.
 */
function lineCommentIds(): (line: number, ownLine: boolean) => number {
	let run: { line: number; id: number } | undefined;
	return (line, ownLine) => {
		const id = ownLine && run?.line === line - 1 ? run.id : newCommentId();
		run = ownLine ? { line, id } : undefined;
		return id;
	};
}

/** Whether only whitespace stands between the start of the line and `offset`. */
function standsAlone(text: string, offset: number): boolean {
	return /^[ \t\uFEFF]*$/.test(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset));
}

/** Split `text` (starting on 1-based `line`) into one piece per line. */
function piecesOf(
	text: string,
	line: number,
	kind: TextPiece['kind'],
	comment?: number
): TextPiece[] {
	return text.split('\n').map((part, index) => ({
		line: line + index,
		text: part,
		kind,
		...(comment === undefined ? {} : { comment }),
	}));
}

const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'suite', 'bench']);

/**
 * `it`, `describe.each(rows)`, `it.skipIf(x)`, ``test.each`a | b` ``: the test
 * function a call goes back to.
 */
function testFunctionOf(callee: ts.Expression): string | undefined {
	let current: ts.Expression = callee;
	for (;;) {
		if (ts.isIdentifier(current))
			return TEST_FUNCTIONS.has(current.text) ? current.text : undefined;
		if (ts.isPropertyAccessExpression(current)) current = current.expression;
		else if (ts.isCallExpression(current)) current = current.expression;
		else if (ts.isTaggedTemplateExpression(current)) current = current.tag;
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
	// Ids are assigned in source order, so a run of `//` lines is found; the
	// pieces keep the order the ranges were collected in.
	const lineCommentId = lineCommentIds();
	const commentIds = new Map<number, number>();
	// Text inside JSX (`<p>// not a comment</p>`) is scanned as trivia by the
	// comment-range helpers; it is copy, not a comment.
	const inJsxText = (range: ts.CommentRange) =>
		jsxText.some(([start, end]) => range.pos >= start && range.pos < end);
	for (const range of ranges.toSorted((a, b) => a.pos - b.pos)) {
		if (commentIds.has(range.pos) || inJsxText(range)) continue;
		const ownLine =
			range.kind === ts.SyntaxKind.SingleLineCommentTrivia && standsAlone(text, range.pos);
		commentIds.set(
			range.pos,
			range.kind === ts.SyntaxKind.SingleLineCommentTrivia
				? lineCommentId(lineOf(range.pos), ownLine)
				: newCommentId()
		);
	}
	for (const range of ranges) {
		if (commentStarts.has(range.pos) || inJsxText(range)) continue;
		commentStarts.add(range.pos);
		const comment = commentIds.get(range.pos);
		pieces.push(
			...piecesOf(text.slice(range.pos, range.end), lineOf(range.pos), 'comment', comment)
		);
	}
	return pieces;
}

/** The 1-based line of an offset into `text`, which starts on `firstLine`. */
function lineCounter(text: string, firstLine = 1): (offset: number) => number {
	const starts = [0];
	for (const match of text.matchAll(/\n/g)) starts.push(match.index + 1);
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (starts[middle]! <= offset) low = middle;
			else high = middle - 1;
		}
		return firstLine + low;
	};
}

interface HereDocument {
	readonly delimiter: string;
	/** `<<-`: the closing line may be indented with tabs. */
	readonly stripTabs: boolean;
}

/** `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<<"EOF"`, `<<\EOF`. */
const HERE_DOCUMENT = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w.-]*))/;

/**
 * A shell syntax context the scanner is inside. `command` is the script itself
 * or a `$(...)` / backquote substitution: only there do `#` comments and
 * here-documents exist. `depth` counts the open parentheses a `$(` or `((`
 * body holds, so its own closing `)` or `))` is the one that ends it.
 */
interface ShellContext {
	readonly kind: 'command' | 'single' | 'double' | 'ansi' | 'parameter' | 'arithmetic';
	/** What closes a command context: `)` for `$(`, a backquote for `` ` ``, nothing for the script. */
	readonly closer?: ')' | '`';
	depth: number;
}

/** The context a `$`, quote or backquote at `column` opens, and how many characters open it. */
function openedContext(line: string, column: number): [ShellContext, number] | undefined {
	const char = line[column];
	if (char === "'") return [{ kind: 'single', depth: 0 }, 1];
	if (char === '"') return [{ kind: 'double', depth: 0 }, 1];
	if (char === '`') return [{ kind: 'command', closer: '`', depth: 0 }, 1];
	if (char !== '$') return undefined;
	const next = line[column + 1];
	if (next === "'") return [{ kind: 'ansi', depth: 0 }, 2];
	if (next === '{') return [{ kind: 'parameter', depth: 0 }, 2];
	if (line.startsWith('$((', column)) return [{ kind: 'arithmetic', depth: 0 }, 3];
	if (next === '(') return [{ kind: 'command', closer: ')', depth: 0 }, 2];
	return undefined;
}

/** Whether `column` starts a shell word, where `#` opens a comment and `((` an arithmetic command. */
function atWordStart(line: string, column: number): boolean {
	return column === 0 || /[\s;&|()]/.test(line[column - 1]!);
}

/**
 * The `#` comments of a shell script that starts on `firstLine`. The scanner
 * keeps a stack of syntax contexts across lines: quoted strings, `${...}`
 * expansions and arithmetic are data, while a `$(...)` or backquote
 * substitution is a script again, even inside double quotes. A `#` opens a
 * comment only at the start of a word in a script context (`${#items[@]}` and
 * `$#` are expansions), `<<` opens a here-document only there (in arithmetic
 * it shifts), and a here-document body runs to its delimiter line.
 */
export function shellCommentPieces(text: string, firstLine = 1): TextPiece[] {
	const pieces: TextPiece[] = [];
	const pending: HereDocument[] = [];
	const bodies: HereDocument[] = [];
	const stack: ShellContext[] = [{ kind: 'command', depth: 0 }];
	const lineCommentId = lineCommentIds();
	for (const [index, line] of text.split('\n').entries()) {
		const body = bodies[0];
		if (body) {
			if ((body.stripTabs ? line.replace(/^\t+/, '') : line) === body.delimiter) bodies.shift();
			continue;
		}
		if (index === 0 && line.startsWith('#!')) continue;
		for (let column = 0; column < line.length; column += 1) {
			const context = stack.at(-1)!;
			const char = line[column]!;
			if (context.kind === 'single') {
				if (char === "'") stack.pop();
				continue;
			}
			if (char === '\\') {
				column += 1;
				continue;
			}
			if (context.kind === 'ansi') {
				if (char === "'") stack.pop();
				continue;
			}
			if (context.kind === 'double' && char === '"') {
				stack.pop();
				continue;
			}
			if (context.kind === 'parameter' && char === '}') {
				stack.pop();
				continue;
			}
			if (context.kind === 'command' && char === context.closer && context.depth === 0) {
				stack.pop();
				continue;
			}
			if (context.kind === 'arithmetic' && char === ')' && context.depth === 0) {
				// `))` ends the expression; a lone `)` is malformed, and ending there keeps the scan going.
				stack.pop();
				if (line[column + 1] === ')') column += 1;
				continue;
			}
			// Only `$`-expansions, quotes and substitutions open inside a double-quoted string.
			const opened =
				context.kind === 'double' && char !== '$' && char !== '`'
					? undefined
					: openedContext(line, column);
			if (opened) {
				stack.push(opened[0]);
				column += opened[1] - 1;
				continue;
			}
			if (context.kind === 'double') continue;
			if (char === '(' || char === ')') {
				if (
					context.kind === 'command' &&
					char === '(' &&
					line[column + 1] === '(' &&
					atWordStart(line, column)
				) {
					stack.push({ kind: 'arithmetic', depth: 0 });
					column += 1;
				} else if (context.closer === ')' || context.kind === 'arithmetic') {
					context.depth += char === '(' ? 1 : -1;
				}
				continue;
			}
			if (context.kind !== 'command') continue;
			if (line.startsWith('<<<', column)) column += 2;
			else if (line.startsWith('<<', column)) {
				const match = HERE_DOCUMENT.exec(line.slice(column));
				if (match) {
					pending.push({
						delimiter: match[2] ?? match[3] ?? match[4]!,
						stripTabs: match[1] === '-',
					});
					column += match[0].length - 1;
				} else column += 1;
			} else if (char === '#' && atWordStart(line, column)) {
				// A comment inside backquotes ends at the closing backquote, elsewhere at the line end.
				const end = context.closer === '`' ? line.indexOf('`', column) : -1;
				const comment = end === -1 ? line.slice(column) : line.slice(column, end);
				pieces.push({
					line: firstLine + index,
					text: comment,
					kind: 'comment',
					comment: lineCommentId(firstLine + index, line.slice(0, column).trim() === ''),
				});
				if (end === -1) break;
				column = end - 1;
			}
		}
		// A here-document body starts on the next line unless that line is still inside a string.
		const kind = stack.at(-1)!.kind;
		if (kind !== 'single' && kind !== 'double' && kind !== 'ansi')
			bodies.push(...pending.splice(0));
	}
	return pieces;
}

interface YamlToken {
	readonly type?: string;
	readonly offset?: number;
	readonly source?: string;
	readonly key?: YamlToken | null;
	readonly value?: YamlToken | null;
}

/** A block scalar's lines without the indentation they share. */
function dedent(source: string): string {
	const lines = source.split('\n');
	const indents = lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)![0].length);
	const shared = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((line) => line.slice(shared)).join('\n');
}

/**
 * The comments of a YAML file, from the YAML parser's comment tokens, so a `#`
 * inside a quoted or block scalar is data. The block scalar of a `run:` key is
 * a shell script (a GitHub Actions step), and its shell comments are read too.
 */
export function yamlCommentPieces(text: string): TextPiece[] {
	const lineOf = lineCounter(text);
	const pieces: TextPiece[] = [];
	const comments: { offset: number; source: string }[] = [];
	const visit = (node: unknown) => {
		if (typeof node !== 'object' || node === null) return;
		const token = node as YamlToken;
		if (token.type === 'comment' && token.offset !== undefined && token.source) {
			comments.push({ offset: token.offset, source: token.source });
		}
		const { key, value } = token;
		if (key?.source === 'run' && value?.type === 'block-scalar' && value.offset !== undefined) {
			// The scalar's content starts on the line after its `|` header.
			pieces.push(...shellCommentPieces(dedent(value.source ?? ''), lineOf(value.offset) + 1));
		}
		for (const child of Object.values(node)) visit(child);
	};
	for (const token of new YamlParser().parse(text)) visit(token);
	const lineCommentId = lineCommentIds();
	for (const { offset, source } of comments.toSorted((a, b) => a.offset - b.offset)) {
		const line = lineOf(offset);
		pieces.push({
			line,
			text: source,
			kind: 'comment',
			comment: lineCommentId(line, standsAlone(text, offset)),
		});
	}
	return pieces.toSorted((a, b) => a.line - b.line);
}

function scriptKindOf(lang: string | undefined): ts.ScriptKind {
	if (lang === 'tsx') return ts.ScriptKind.TSX;
	if (lang === 'jsx') return ts.ScriptKind.JSX;
	if (lang === 'ts') return ts.ScriptKind.TS;
	return ts.ScriptKind.JS;
}

/** The comment nodes of a template, wherever they nest. */
function templateCommentPieces(node: RootNode | TemplateChildNode): TextPiece[] {
	if (node.type === NodeTypes.COMMENT)
		return piecesOf(node.loc.source, node.loc.start.line, 'comment', newCommentId());
	if (node.type !== NodeTypes.ROOT && node.type !== NodeTypes.ELEMENT) return [];
	return node.children.flatMap((child) => templateCommentPieces(child));
}

/** A string, an unquoted `url(...)`, a block comment, or a `//` line. */
const STYLE_TOKEN =
	/"(?:[^"\\\n]|\\(?:\r\n|[\s\S]))*"?|'(?:[^'\\\n]|\\(?:\r\n|[\s\S]))*'?|\burl\(\s*[^\s'")][^)]*\)?|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/gi;
const LINE_COMMENT_STYLES = new Set(['scss', 'sass', 'less', 'stylus', 'styl']);

/** The comments of a `<style>` block; `//` lines count in the preprocessors that have them. */
function styleCommentPieces(
	content: string,
	firstLine: number,
	lang: string | undefined
): TextPiece[] {
	const lineOf = lineCounter(content, firstLine);
	const lineCommentId = lineCommentIds();
	const pieces: TextPiece[] = [];
	for (const match of content.matchAll(STYLE_TOKEN)) {
		const token = match[0];
		const line = lineOf(match.index);
		if (token.startsWith('/*')) pieces.push(...piecesOf(token, line, 'comment', newCommentId()));
		else if (token.startsWith('//') && LINE_COMMENT_STYLES.has(lang ?? '')) {
			const comment = lineCommentId(line, standsAlone(content, match.index));
			pieces.push(...piecesOf(token, line, 'comment', comment));
		}
	}
	return pieces;
}

/** Comment lines and test titles of a single-file component; undefined if it does not parse. */
export function vuePieces(text: string): TextPiece[] | undefined {
	const { descriptor, errors } = parse(text, {
		filename: 'file.vue',
		templateParseOptions: { comments: true },
	});
	if (errors.length > 0) return undefined;
	const pieces: TextPiece[] = [];
	for (const block of [descriptor.script, descriptor.scriptSetup]) {
		if (block)
			pieces.push(...scriptPieces(block.content, scriptKindOf(block.lang), block.loc.start.line));
	}
	// A template in another language (pug) has no AST; its comments are not read.
	if (descriptor.template?.ast) pieces.push(...templateCommentPieces(descriptor.template.ast));
	for (const style of descriptor.styles) {
		pieces.push(...styleCommentPieces(style.content, style.loc.start.line, style.lang));
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
const SHELL_EXTENSIONS = new Set(['sh', 'bash']);
const YAML_EXTENSIONS = new Set(['yml', 'yaml']);

/** Whether the gate reads a file of this path at all. */
export function isCheckedPath(path: string): boolean {
	if (/(^|\/)_generated\//.test(path)) return false;
	const extension = /\.([^./]+)$/.exec(path)?.[1] ?? '';
	return (
		extension in SCRIPT_KINDS ||
		extension === 'vue' ||
		SHELL_EXTENSIONS.has(extension) ||
		YAML_EXTENSIONS.has(extension)
	);
}

/** Each comment piece with the comment line directly above it, when there is one. */
function withLineAbove(pieces: TextPiece[]): TextPiece[] {
	const comments = new Map<number, string>();
	for (const piece of pieces) if (piece.kind === 'comment') comments.set(piece.line, piece.text);
	return pieces.map((piece) => {
		const above = piece.kind === 'comment' ? comments.get(piece.line - 1) : undefined;
		return above === undefined ? piece : { ...piece, previous: above };
	});
}

/** The pieces of a file by its extension, before they are linked to the lines above. */
function rawPiecesOfFile(extension: string, text: string): TextPiece[] | undefined {
	if (extension === 'vue') return vuePieces(text);
	if (SHELL_EXTENSIONS.has(extension)) return shellCommentPieces(text);
	if (YAML_EXTENSIONS.has(extension)) return yamlCommentPieces(text);
	return scriptPieces(text, SCRIPT_KINDS[extension]!);
}

/**
 * The comment lines and test titles of a file, by its extension; undefined
 * when the gate does not read this kind of file or cannot parse it.
 */
export function piecesOfFile(path: string, text: string): TextPiece[] | undefined {
	if (!isCheckedPath(path)) return undefined;
	const pieces = rawPiecesOfFile(/\.([^./]+)$/.exec(path)![1]!, text);
	return pieces && withLineAbove(pieces);
}
