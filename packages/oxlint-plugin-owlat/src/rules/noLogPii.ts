import { inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { ScopeOptions } from '../lib/paths.ts';
import {
	bindingOf,
	declaratorOf,
	destructuredKey,
	importedThrough,
	keyName,
	memberName,
	optedOut,
	staticString,
	unwrap,
	walk,
} from '../lib/ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

/**
 * Correspondent addresses and message subjects stay out of the process log.
 * The function log is shipped to whatever aggregator the operator points at,
 * read by people who hold no mail-content grant, and outlives the message it
 * describes. The `@owlat/shared/logRedaction` helpers keep the domain and a
 * stable digest, so lines about the same correspondent still correlate.
 *
 * Inside the arguments of a `logInfo` / `logWarn` / `logError` / `logDebug` /
 * `logEvent` / `console.{log,info,warn,error,debug}` call (for `logEvent`
 * that includes its nested `detail` object; recognized through import
 * aliases, namespaces and local aliases, including the methods imported from
 * `node:console`), every object property keyed
 * `from | to | subject | email | recipient | rcptTo | mailFrom | address |
 * sender` (plain, quoted or shorthand) must take its value through
 * `redactEmailAddress` / `redactEmailAddresses` / `redactSubject` /
 * `redactionDigest` (likewise under any alias). Each property is judged on its
 * own value, and the value is judged by what it evaluates to: a redactor call,
 * `list.map(<redactor>)`, `<redacted>.join(…)`, an array or template of
 * redacted parts, or a conditional / logical expression whose every outcome
 * is redacted or `null` / `undefined`. A redactor appearing somewhere inside
 * an otherwise raw value does not count, nor does a redacted neighbour. Qualified names (`fromDomain`, `toCount`,
 * `senderId`) are a domain, a count or an id and are out of scope, as are
 * template-literal holes.
 *
 * Opt-out, for a key that is not a correspondent address or subject:
 * `// log-pii-safe: <why>` inside the call or in the comment lines directly
 * above it. Only process logs are in scope; rows persisted on purpose (audit
 * logs, delivery logs) are a different question.
 */

const LOG_FUNCTIONS = new Set(['logInfo', 'logWarn', 'logError', 'logDebug', 'logEvent']);
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const SENSITIVE_KEYS = new Set([
	'from',
	'to',
	'subject',
	'email',
	'recipient',
	'rcptTo',
	'mailFrom',
	'address',
	'sender',
]);
/** The `@owlat/shared/logRedaction` helpers, matched by imported name through any alias. */
const REDACTORS = new Set([
	'redactEmailAddress',
	'redactEmailAddresses',
	'redactSubject',
	'redactionDigest',
]);

/** Bound on alias chains and nested value shapes. */
const MAX_DEPTH = 8;

/** Modules whose exports are the console methods (`import { warn } from 'node:console'`). */
const CONSOLE_MODULES = new Set(['console', 'node:console']);

/**
 * Whether `node` names the console object: any identifier spelled `console`
 * (the global, or a namespace / default import of a console module under that
 * name), `globalThis.console`, a namespace or default import of a console
 * module under another name, or a local alias of any of these.
 */
const isConsoleObject = (context: Context, node: AstNode, depth = 0): boolean => {
	const current = unwrap(node);
	if (current?.type === 'MemberExpression') {
		const object = unwrap(current.object as AstNode);
		return (
			memberName(current) === 'console' &&
			object?.type === 'Identifier' &&
			object.name === 'globalThis'
		);
	}
	if (current?.type !== 'Identifier') return false;
	if (current.name === 'console') return true;
	const binding = bindingOf(context, current);
	if (binding.type === 'import') {
		return (
			CONSOLE_MODULES.has(binding.source) &&
			(binding.imported === '*' || binding.imported === 'default')
		);
	}
	const local = declaratorOf(binding);
	return (
		local !== undefined &&
		local.alias &&
		depth < MAX_DEPTH &&
		isConsoleObject(context, local.declarator.init as AstNode, depth + 1)
	);
};

/**
 * The function a callee stands for, by binding rather than spelling: an
 * imported name through any alias or namespace, a member (`x.logInfo`,
 * `console.warn`), and a local alias of either (`const info = logInfo`,
 * `const warn = console.warn`, `const { warn } = console`). Without `members`,
 * a member of anything but a namespace import resolves to nothing.
 */
const callTarget = (
	context: Context,
	callee: AstNode,
	members: boolean,
	depth = 0
): { name: string; onConsole: boolean } | undefined => {
	const current = unwrap(callee);
	const imported = importedThrough(context, current);
	if (imported) return { name: imported.name, onConsole: CONSOLE_MODULES.has(imported.source) };
	if (current?.type === 'MemberExpression') {
		if (!members) return undefined;
		const name = memberName(current);
		const onConsole = isConsoleObject(context, current.object as AstNode);
		return name === undefined ? undefined : { name, onConsole };
	}
	if (current?.type !== 'Identifier') return undefined;
	const local = declaratorOf(bindingOf(context, current));
	if (local && depth < MAX_DEPTH) {
		const init = unwrap(local.declarator.init as AstNode);
		if (local.alias && (init?.type === 'Identifier' || init?.type === 'MemberExpression')) {
			return (
				callTarget(context, init, members, depth + 1) ?? { name: current.name, onConsole: false }
			);
		}
		const key = destructuredKey(local.declarator.id as AstNode, local.name);
		if (members && key !== undefined && init) {
			return { name: key, onConsole: isConsoleObject(context, init) };
		}
	}
	return { name: current.name, onConsole: false };
};

const isLogCall = (context: Context, node: AstNode): boolean => {
	if (node.type !== 'CallExpression') return false;
	const target = callTarget(context, node.callee as AstNode, true);
	if (target === undefined) return false;
	return LOG_FUNCTIONS.has(target.name) || (target.onConsole && CONSOLE_METHODS.has(target.name));
};

/** A redactor is resolved by binding only: `util.redactEmailAddress` is some other function. */
const isRedactor = (context: Context, node: AstNode): boolean => {
	const target = callTarget(context, node, false);
	return target !== undefined && REDACTORS.has(target.name);
};

/**
 * Whether every value `node` can evaluate to went through a redactor. The
 * expression itself is judged, not whether a redactor appears somewhere in it,
 * so `cond ? redactEmailAddress(to) : to` is not redacted.
 */
const redacted = (context: Context, node: AstNode, depth = 0): boolean => {
	const current = unwrap(node);
	if (!current || depth > MAX_DEPTH) return false;
	switch (current.type) {
		case 'CallExpression': {
			if (isRedactor(context, current.callee as AstNode)) return true;
			const callee = unwrap(current.callee as AstNode);
			if (callee?.type !== 'MemberExpression') return false;
			const method = memberName(callee);
			const [first, ...rest] = current.arguments as AstNode[];
			// `list.map(redactEmailAddress)` / `list.map((a) => redactEmailAddress(a))`
			if (method === 'map' && first && rest.length === 0) {
				const mapper = unwrap(first);
				if (
					(mapper?.type === 'ArrowFunctionExpression' || mapper?.type === 'FunctionExpression') &&
					mapper.body?.type !== 'BlockStatement'
				) {
					return redacted(context, mapper.body as AstNode, depth + 1);
				}
				return mapper !== undefined && mapper !== null && isRedactor(context, mapper);
			}
			// `redactEmailAddresses(list).join(', ')`
			if (method === 'join' && (current.arguments as AstNode[]).every(isStatic)) {
				return redacted(context, callee.object as AstNode, depth + 1);
			}
			return false;
		}
		case 'ConditionalExpression':
			return (
				redacted(context, current.consequent as AstNode, depth + 1) &&
				redacted(context, current.alternate as AstNode, depth + 1)
			);
		case 'LogicalExpression':
			// `a && b` yields `a` only when it is falsy (no address), else `b`.
			return (
				(current.operator === '&&' || redacted(context, current.left as AstNode, depth + 1)) &&
				redacted(context, current.right as AstNode, depth + 1)
			);
		case 'ArrayExpression':
			return current.elements.every(
				(element) =>
					element !== null &&
					element.type !== 'SpreadElement' &&
					redacted(context, element as AstNode, depth + 1)
			);
		case 'TemplateLiteral':
			// A template without holes is a string literal and is judged like one;
			// with holes, every hole must be redacted (the text between is source).
			return (
				current.expressions.length > 0 &&
				current.expressions.every((expression) =>
					redacted(context, expression as AstNode, depth + 1)
				)
			);
		default:
			return isNullish(context, current);
	}
};

/** `null` / `undefined`: an absent value carries no address. */
const isNullish = (context: Context, node: AstNode): boolean =>
	(node.type === 'Literal' && node.value === null && !('regex' in node && node.regex)) ||
	(node.type === 'Identifier' &&
		node.name === 'undefined' &&
		bindingOf(context, node).type === 'global');

const isStatic = (node: AstNode): boolean => staticString(node) !== undefined;

const MESSAGE = (key: string) =>
	`\`${key}\` puts a correspondent address or subject into the process log, which is shipped off-box and read without a mail-content grant. Redact the value (redactEmailAddress / redactSubject from @owlat/shared/logRedaction) instead of dropping the field, or, if it is not an address or subject, say so with \`// log-pii-safe: <reason>\`.`;

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Keep correspondent addresses and subjects out of process-log calls.',
		},
		schema: [{ type: 'object', properties: SCOPE_SCHEMA, additionalProperties: false }],
	},
	create(context) {
		const options = context.options[0] as ScopeOptions | undefined;
		if (!inScope(slashed(context.filename), options)) return {};
		if (!/log(?:Info|Warn|Error|Debug|Event)|console/u.test(context.sourceCode.text)) return {};
		const reported = new Set<AstNode>();
		return {
			CallExpression(node) {
				if (!isLogCall(context, node)) return;
				let excused: boolean | undefined;
				for (const argument of node.arguments as AstNode[]) {
					// Callbacks included: `rs.map((r) => ({ to: r.address }))` builds the
					// logged payload as surely as a literal does.
					// Only object literals build a payload: an `ObjectPattern` property such
					// as a callback's `({ email }) =>` parameter binds a name, logs nothing.
					walk(context, argument, (child) => {
						if (child.type !== 'ObjectExpression') return;
						for (const property of child.properties as AstNode[]) {
							if (property.type !== 'Property') continue;
							const key = keyName(property);
							if (key === undefined || !SENSITIVE_KEYS.has(key) || reported.has(property)) continue;
							if (redacted(context, property.value as AstNode)) continue;
							excused ??= optedOut(context, node, 'log-pii-safe');
							if (excused) return;
							reported.add(property);
							context.report({ node: property, message: MESSAGE(key) });
						}
					});
				}
			},
		};
	},
};

export default rule;
