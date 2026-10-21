import type { Comment, Rule } from '../types.ts';

/**
 * Every lint or type-checker suppression says why, so a reader can tell a
 * deliberate exception from a silenced bug, and a stale one can be judged when
 * the code around it changes. The reason is either the ESLint-style `-- reason`
 * tail of a lint directive, text after a TypeScript directive (or, in a block
 * comment, on its earlier lines), or an ordinary comment directly above the
 * directive (other directives and empty comment lines in between are skipped,
 * a blank source line is not).
 *
 * A TypeScript directive is recognized in exactly the comment forms the
 * compiler honours, so no form TypeScript obeys can carry a silent
 * suppression: `@ts-expect-error` / `@ts-ignore` at the start of a `//` or
 * `///` comment or of a block comment's last line (after any `/` and `*`), even
 * with letters glued to the name, and `@ts-nocheck` as a `//` or `///` pragma
 * in any letter case.
 *
 * Generated files are exempt: their directives come from the generator, and the
 * fix belongs there. A file counts as generated when a comment in its header
 * (before the first statement) carries the conventional `@generated` marker,
 * says the code is automatically generated, or says it is generated and must
 * not be edited.
 */

const LINT_DIRECTIVE = /^[\s*]*(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?(?![\w-])/u;
// The compiler's own patterns, applied to the comment value (TypeScript sees
// the `//` or the block comment's last line, `/*` included).
const TS_SUPPRESSION_LINE = /^\/?\s*@ts-(?:expect-error|ignore)(.*)$/su;
const TS_SUPPRESSION_BLOCK_LAST_LINE = /^[/*]*\s*@ts-(?:expect-error|ignore)(.*)$/su;
const TS_NOCHECK_LINE = /^\/?\s*@ts-nocheck((?:[^\S\r\n]|:).*)?$/iu;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;
const EMPTY_COMMENT = /^[\s*]*$/u;
const GENERATED_MARKER =
	/@generated\b|\bauto(?:matically)?[- ]generated\b|\bgenerated\b[^\n]*\bdo not (?:edit|modify)\b|\bdo not (?:edit|modify)\b[^\n]*\bgenerated\b/iu;

const LINT_MESSAGE =
	'Say why this suppression is needed: end the directive with `-- reason` or put a comment on the line above.';
const TS_MESSAGE =
	'Say why this TypeScript directive is needed: write the reason after it or in a comment on the line above.';

/** Strips the separators a reason may open with, plus letters glued to the directive name. */
const reasonText = (text: string, afterName: boolean) =>
	(afterName ? text.replace(/^[\w-]*/u, '') : text).replace(/^[\s*:-]+/u, '').trim();

/**
 * The reason a TypeScript directive comment carries ('' for none), or
 * undefined when TypeScript would not read the comment as a directive.
 */
function typeScriptDirectiveReason(comment: Comment): string | undefined {
	if (comment.type === 'Line') {
		const pragma = TS_NOCHECK_LINE.exec(comment.value);
		if (pragma) return reasonText(pragma[1] ?? '', false);
		const tail = TS_SUPPRESSION_LINE.exec(comment.value)?.[1];
		return tail === undefined ? undefined : reasonText(tail, true);
	}
	const lines = comment.value.split(LINE_BREAK);
	const tail = TS_SUPPRESSION_BLOCK_LAST_LINE.exec(lines.pop()!.trimStart())?.[1];
	if (tail === undefined) return undefined;
	const earlier = lines.map((line) => reasonText(line, false)).filter(Boolean);
	return [...earlier, reasonText(tail, true)].join(' ').trim();
}

const isDirective = (comment: Comment) =>
	LINT_DIRECTIVE.test(comment.value) || typeScriptDirectiveReason(comment) !== undefined;

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Require every lint or TypeScript suppression to state its reason.',
		},
	},
	create(context) {
		const { sourceCode } = context;
		// Most files carry no directive at all; skip them before touching comments.
		if (!/lint-disable|@ts-(?:expect-error|ignore|nocheck)/iu.test(sourceCode.text)) return {};
		return {
			Program() {
				const comments = sourceCode.getAllComments();
				const bodyStart = sourceCode.ast.body[0]?.start ?? Number.POSITIVE_INFINITY;
				const header = comments.filter((comment) => comment.end <= bodyStart);
				if (header.some((comment) => GENERATED_MARKER.test(comment.value))) return;

				// Only comments that start their own line can explain the line below;
				// a trailing comment belongs to the code it trails.
				const ownLineByEndLine = new Map<number, Comment>();
				for (const comment of comments) {
					const { line, column } = comment.loc.start;
					if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') {
						ownLineByEndLine.set(comment.loc.end.line, comment);
					}
				}

				const explainedAbove = (directive: Comment) => {
					let above = ownLineByEndLine.get(directive.loc.start.line - 1);
					while (above && (isDirective(above) || EMPTY_COMMENT.test(above.value))) {
						above = ownLineByEndLine.get(above.loc.start.line - 1);
					}
					return above !== undefined;
				};

				for (const directive of sourceCode.getDisableDirectives().directives) {
					if (directive.type === 'enable' || directive.justification?.trim()) continue;
					if (explainedAbove(directive.node)) continue;
					context.report({ loc: directive.node.loc, message: LINT_MESSAGE });
				}

				for (const comment of comments) {
					const reason = typeScriptDirectiveReason(comment);
					if (reason === undefined || reason) continue;
					if (explainedAbove(comment)) continue;
					context.report({ loc: comment.loc, message: TS_MESSAGE });
				}
			},
		};
	},
};

export default rule;
