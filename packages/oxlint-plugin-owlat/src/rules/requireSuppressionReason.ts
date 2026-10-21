import type { Comment, Rule } from '../types.ts';

/**
 * Every lint or type-checker suppression says why, so a reader can tell a
 * deliberate exception from a silenced bug, and a stale one can be judged when
 * the code around it changes. The reason is either the ESLint-style `-- reason`
 * tail of a lint directive, text after a TypeScript directive, or an ordinary
 * comment directly above the directive (other directives and empty comment
 * lines in between are skipped, a blank source line is not).
 *
 * Generated files are exempt: their directives come from the generator, and the
 * fix belongs there. A file counts as generated when a comment in its header
 * (before the first statement) carries the conventional `@generated` marker,
 * says the code is automatically generated, or says it is generated and must
 * not be edited.
 */

const LINT_DIRECTIVE = /^[\s*]*(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?(?![\w-])/u;
const TS_DIRECTIVE = /^[\s*]*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const EMPTY_COMMENT = /^[\s*]*$/u;
const GENERATED_MARKER =
	/@generated\b|\bauto(?:matically)?[- ]generated\b|\bgenerated\b[^\n]*\bdo not (?:edit|modify)\b|\bdo not (?:edit|modify)\b[^\n]*\bgenerated\b/iu;

const LINT_MESSAGE =
	'Say why this suppression is needed: end the directive with `-- reason` or put a comment on the line above.';
const TS_MESSAGE =
	'Say why this TypeScript directive is needed: write the reason after it or in a comment on the line above.';

const isDirective = (comment: Comment) =>
	LINT_DIRECTIVE.test(comment.value) || TS_DIRECTIVE.test(comment.value);

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
		if (!/(?:lint-disable|@ts-(?:expect-error|ignore|nocheck))/u.test(sourceCode.text)) return {};
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
					const tail = TS_DIRECTIVE.exec(comment.value)?.[1];
					if (tail === undefined) continue;
					if (tail.replace(/^[\s:-]+/u, '').trim()) continue;
					if (explainedAbove(comment)) continue;
					context.report({ loc: comment.loc, message: TS_MESSAGE });
				}
			},
		};
	},
};

export default rule;
