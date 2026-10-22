import { inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { ScopeOptions } from '../lib/paths.ts';
import { calleeName, keyName, optedOut, unwrap, walk } from '../lib/ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

/**
 * Correspondent addresses and message subjects stay out of the process log.
 * The function log is shipped to whatever aggregator the operator points at,
 * read by people who hold no mail-content grant, and outlives the message it
 * describes. The `@owlat/shared/logRedaction` helpers keep the domain and a
 * stable digest, so lines about the same correspondent still correlate.
 *
 * Inside the arguments of a `logInfo` / `logWarn` / `logError` / `logDebug` /
 * `console.{log,info,warn,error,debug}` call, every object property keyed
 * `from | to | subject | email | recipient | rcptTo | mailFrom | address |
 * sender` (plain, quoted or shorthand) must take its value through
 * `redactEmailAddress` / `redactEmailAddresses` / `redactSubject` /
 * `redactionDigest`. Each property is judged on its own value, so a redacted
 * neighbour does not excuse it. Qualified names (`fromDomain`, `toCount`,
 * `senderId`) are a domain, a count or an id and are out of scope, as are
 * template-literal holes.
 *
 * Opt-out, for a key that is not a correspondent address or subject:
 * `// log-pii-safe: <why>` inside the call or in the comment lines directly
 * above it. Only process logs are in scope; rows persisted on purpose (audit
 * logs, delivery logs) are a different question.
 */

const LOG_FUNCTIONS = new Set(['logInfo', 'logWarn', 'logError', 'logDebug']);
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
const REDACTORS = new Set([
	'redactEmailAddress',
	'redactEmailAddresses',
	'redactSubject',
	'redactionDigest',
]);

const isLogCall = (node: AstNode): boolean => {
	if (node.type !== 'CallExpression') return false;
	const callee = unwrap(node.callee as AstNode);
	const name = calleeName(callee);
	if (name === undefined) return false;
	if (LOG_FUNCTIONS.has(name)) return true;
	if (callee?.type !== 'MemberExpression' || !CONSOLE_METHODS.has(name)) return false;
	const object = unwrap(callee.object as AstNode);
	return object?.type === 'Identifier' && object.name === 'console';
};

const redacted = (context: Context, value: AstNode): boolean => {
	let found = false;
	walk(context, value, (node) => {
		if (found) return false;
		if (node.type === 'Identifier' && REDACTORS.has(node.name)) found = true;
		return !found;
	});
	return found;
};

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
		if (!/log(?:Info|Warn|Error|Debug)|console/u.test(context.sourceCode.text)) return {};
		const reported = new Set<AstNode>();
		return {
			CallExpression(node) {
				if (!isLogCall(node)) return;
				let excused: boolean | undefined;
				for (const argument of node.arguments as AstNode[]) {
					// Callbacks included: `rs.map((r) => ({ to: r.address }))` builds the
					// logged payload as surely as a literal does.
					walk(context, argument, (child) => {
						const key = child.type === 'Property' ? keyName(child) : undefined;
						if (key === undefined || !SENSITIVE_KEYS.has(key) || reported.has(child)) return;
						if (child.type !== 'Property' || redacted(context, child.value as AstNode)) return;
						excused ??= optedOut(context, node, 'log-pii-safe');
						if (excused) return;
						reported.add(child);
						context.report({ node: child, message: MESSAGE(key) });
					});
				}
			},
		};
	},
};

export default rule;
