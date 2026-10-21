import type { Rule } from '../types.ts';

/**
 * A test file's environment comes from its package's vitest config. A per-file
 * `@vitest-environment` pragma either repeats that config (noise that hides the
 * real exceptions) or quietly forks it, so the rule rejects every pragma unless
 * the rule options allow that environment for that file:
 *
 *   "owlat/no-test-environment-pragma": ["error", {
 *     "allow": [{ "environment": "node", "files": ["apps/web/e2e/__tests__/x.test.ts"] }]
 *   }]
 *
 * `files` are repository-relative globs (`*`, `**`, `?`). They are matched as a
 * path suffix at a directory boundary rather than against the working
 * directory, because oxlint runs from the repository root and from each
 * workspace with the same config, and its own `overrides` globs resolve against
 * whichever directory that is.
 *
 * A pragma only counts when it opens a comment line, the way vitest reads it;
 * prose that mentions the pragma mid-sentence is not one.
 */

const PRAGMA = /^[\s*]*@(?:vitest|jest)-environment[ \t]+([^\s*]+)/mu;

interface Allowance {
	environment: string;
	files: string[];
}

interface Options {
	allow?: Allowance[];
}

const compiled = new Map<string, RegExp>();

const globToRegExp = (glob: string): RegExp => {
	const cached = compiled.get(glob);
	if (cached) return cached;
	let pattern = '';
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] as string;
		if (char === '*' && glob[index + 1] === '*') {
			const slash = glob[index + 2] === '/';
			pattern += slash ? '(?:.*/)?' : '.*';
			index += slash ? 2 : 1;
		} else if (char === '*') {
			pattern += '[^/]*';
		} else if (char === '?') {
			pattern += '[^/]';
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
		}
	}
	const regExp = new RegExp(`(?:^|/)${pattern}$`, 'u');
	compiled.set(glob, regExp);
	return regExp;
};

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				"Reject per-file test environment pragmas; the package's vitest config selects the environment.",
		},
		schema: [
			{
				type: 'object',
				properties: {
					allow: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								environment: { type: 'string' },
								files: { type: 'array', items: { type: 'string' } },
							},
							required: ['environment', 'files'],
							additionalProperties: false,
						},
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		if (!context.sourceCode.text.includes('-environment')) return {};
		const filename = context.filename.replaceAll('\\', '/');
		const allowed = new Set(
			((context.options[0] as Options | undefined)?.allow ?? [])
				.filter(({ files }) => files.some((glob) => globToRegExp(glob).test(filename)))
				.map(({ environment }) => environment)
		);
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					const environment = PRAGMA.exec(comment.value)?.[1];
					if (environment === undefined || allowed.has(environment)) continue;
					context.report({
						loc: comment.loc,
						message: `Drop this \`@vitest-environment ${environment}\` pragma: the package's vitest config selects the test environment. A deliberate exception is listed under owlat/no-test-environment-pragma "allow" in oxlintrc.json.`,
					});
				}
			},
		};
	},
};

export default rule;
