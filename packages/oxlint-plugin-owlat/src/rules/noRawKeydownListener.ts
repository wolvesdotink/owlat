import { matchesFileGlobs } from '../fileGlobs.ts';
import type { AstNode, Rule } from '../types.ts';

/**
 * Keyboard shortcuts in the web app go through ONE registry: a catalog entry
 * (`apps/web/app/utils/shortcutCatalog.ts`) bound to a handler with
 * `useKeyboardShortcuts`. That is what lets a person remap a key on the
 * shortcuts page, lets the "?" sheet list it, and lets the registry refuse a
 * second command on the same key. A raw `keydown` listener on the window or
 * the document answers its keys behind all three, so this rule reports one:
 *
 *   - `<target>.addEventListener('keydown', …)` on any target,
 *   - `<target>.onkeydown = …`,
 *   - VueUse's `useEventListener(…, 'keydown', …)` and `onKeyStroke(…)`.
 *
 * Template `@keydown` handlers are not reported: they belong to the element
 * that has focus (a listbox, an editor, a capture field), which is where keys
 * that are not shortcuts live. A listener that genuinely is not a shortcut —
 * the dispatcher itself, an Escape or focus handler for a menu, an editor's own
 * keys, passive instrumentation, a handler that resolves its keys through the
 * registry — stays, behind a suppression whose reason says which.
 *
 * The rule reports only in the files its `files` option names (path-suffix
 * globs, see `fileGlobs.ts`), so the root gates and a workspace's own `lint`
 * agree on where it applies:
 *
 *   "owlat/no-raw-keydown-listener": ["warn", { "files": ["apps/web/app/**"] }]
 *
 * Test files are skipped: they dispatch and listen to keys to drive the code
 * under test. Only a literal event name is matched (`'keydown'` or a template
 * literal without expressions); a listener added for a list of event names is
 * not a shortcut handler.
 */

const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u;

type Node = AstNode & Record<string, unknown>;

const isKeydownLiteral = (node: unknown): boolean => {
	const value = node as Node | undefined;
	if (!value) return false;
	if (value.type === 'Literal') return value.value === 'keydown';
	if (value.type === 'TemplateLiteral') {
		const quasis = value.quasis as { value: { cooked: string | null } }[];
		const expressions = value.expressions as unknown[];
		return expressions.length === 0 && quasis[0]?.value.cooked === 'keydown';
	}
	return false;
};

const propertyName = (node: unknown): string | null => {
	const member = node as Node | undefined;
	if (member?.type !== 'MemberExpression' || member.computed) return null;
	const property = member.property as Node;
	return property.type === 'Identifier' ? (property.name as string) : null;
};

const calleeName = (callee: unknown): string | null => {
	const node = callee as Node;
	if (node.type === 'Identifier') return node.name as string;
	return propertyName(node);
};

const MESSAGE =
	'Bind a catalog id with useKeyboardShortcuts (apps/web/app/utils/shortcutCatalog.ts) instead of a raw keydown listener, so the key can be remapped and appears on the shortcuts page. A listener that is not a shortcut says why in a suppression reason.';

interface Options {
	files?: string[];
}

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Disallow raw keydown listeners in the web app; shortcuts go through the shortcut registry.',
		},
		schema: [
			{
				type: 'object',
				properties: { files: { type: 'array', items: { type: 'string' } } },
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const { text } = context.sourceCode;
		if (!text.includes('keydown') && !text.includes('onKeyStroke')) return {};
		const filename = context.filename.replaceAll('\\', '/');
		if (TEST_FILE.test(filename)) return {};
		const files = (context.options[0] as Options | undefined)?.files;
		if (files && !matchesFileGlobs(filename, files)) return {};
		return {
			CallExpression(node) {
				const call = node as unknown as Node;
				const name = calleeName(call.callee);
				const args = call.arguments as unknown[];
				const report =
					(name === 'addEventListener' && isKeydownLiteral(args[0])) ||
					(name === 'useEventListener' && args.slice(0, 2).some(isKeydownLiteral)) ||
					name === 'onKeyStroke';
				if (report) context.report({ node, message: MESSAGE });
			},
			AssignmentExpression(node) {
				const assignment = node as unknown as Node;
				if (propertyName(assignment.left) === 'onkeydown') {
					context.report({ node, message: MESSAGE });
				}
			},
		};
	},
};

export default rule;
