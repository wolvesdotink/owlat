/**
 * The source scan behind scripts/check-desktop-invoke-contract.ts: every way a
 * file can reach the Tauri IPC `invoke`, and whether each use is one the gate
 * can read.
 *
 * The rule, fail-closed by construction:
 * - A *taint* is any binding or reference that can reach the IPC:
 *   `invoke` imported from `@tauri-apps/api/core` (any alias, static or as
 *   `const { invoke } = await import(...)`), a namespace of that module
 *   (`import * as core`, `const core = await import(...)`), and any reference
 *   to the `__TAURI_INTERNALS__` / `__TAURI__` globals, by identifier,
 *   property (`window.__TAURI_INTERNALS__`) or string key
 *   (`window['__TAURI_INTERNALS__']`).
 * - The only accepted use of a taint is a direct call: `invoke(...)`,
 *   `core.invoke(...)`, `(await import(core)).invoke(...)`,
 *   `__TAURI_INTERNALS__.invoke(...)`, `__TAURI__.core.invoke(...)`. Reading
 *   another member of the namespace (`core.Channel`) is fine, and type
 *   positions (`typeof invoke`) are erased.
 * - Every other use is an "untraceable invoke use" finding: exporting or
 *   re-exporting, destructuring, element access, assignment, passing as a
 *   value, a default import, a dynamic import consumed any other way.
 *
 * Limits, by design: names are matched per file, not per scope, so a shadowing
 * local can only add findings; code outside the scanned directories, and
 * strings handed to `eval` or a webview from Rust, are not seen.
 */
import ts from 'typescript';

export const CORE_MODULE = '@tauri-apps/api/core';

const TAURI_GLOBALS = new Set(['__TAURI_INTERNALS__', '__TAURI__']);

export const TAURI_GLOBAL_PATTERN = /__TAURI(?:_INTERNALS)?__/;

export interface InvokeCall {
	readonly line: number;
	readonly arg: ts.Expression | undefined;
}

export interface FileScan {
	readonly calls: InvokeCall[];
	readonly problems: { line: number; message: string }[];
}

/**
 * A `.vue` file with everything outside its `<script>` blocks blanked, newlines
 * kept, so offsets and line numbers still match the file.
 */
export function vueScript(text: string): string {
	const keep = new Uint8Array(text.length);
	for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
		const start = match.index + match[0].indexOf('>') + 1;
		keep.fill(1, start, start + (match[1] as string).length);
	}
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i] as string;
		out += keep[i] || char === '\n' ? char : ' ';
	}
	return out;
}

function isCoreImport(node: ts.Node): node is ts.CallExpression {
	const [arg] = ts.isCallExpression(node) ? node.arguments : [];
	return (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword &&
		node.arguments.length === 1 &&
		arg !== undefined &&
		ts.isStringLiteralLike(arg) &&
		arg.text === CORE_MODULE
	);
}

/** Skip `await` and parentheses between an expression and what consumes it. */
function outermost(node: ts.Node): ts.Node {
	let current = node;
	while (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
		current = current.parent;
	}
	return current;
}

/** The expression `node` is a member `name` of, when it is (`node.name`). */
function member(node: ts.Node, name: string): ts.Node | undefined {
	const parent = outermost(node).parent;
	return ts.isPropertyAccessExpression(parent) &&
		outermost(node) === parent.expression &&
		parent.name.text === name
		? parent
		: undefined;
}

function isCallee(node: ts.Node): boolean {
	const parent = outermost(node).parent;
	return ts.isCallExpression(parent) && parent.expression === outermost(node);
}

function inTypePosition(node: ts.Node): boolean {
	for (let at = node.parent; at && !ts.isStatement(at); at = at.parent) {
		if (ts.isTypeNode(at) && !ts.isExpressionWithTypeArguments(at)) return true;
	}
	return false;
}

/**
 * An identifier that only names something (a property, a declared member, an
 * import or export from elsewhere) rather than referring to a local binding.
 */
function isNameOnly(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
	if (ts.isQualifiedName(parent)) return parent.right === node;
	if (
		(ts.isPropertyAssignment(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isMethodSignature(parent) ||
			ts.isEnumMember(parent)) &&
		parent.name === node
	) {
		return true;
	}
	if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
		return true;
	}
	if (ts.isExportSpecifier(parent)) {
		const fromElsewhere = parent.parent.parent.moduleSpecifier !== undefined;
		return fromElsewhere || (parent.propertyName !== undefined && parent.name === node);
	}
	return ts.isBindingElement(parent) && parent.propertyName === node;
}

export function scanFile(source: ts.SourceFile): FileScan {
	const calls: FileScan['calls'] = [];
	const problems: FileScan['problems'] = [];
	const line = (node: ts.Node) =>
		source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const untraceable = (node: ts.Node, what: string) =>
		problems.push({ line: line(node), message: `untraceable invoke use: ${what}` });
	const invokeNames = new Set<string>();
	const namespaces = new Set<string>();
	const declarations = new Set<ts.Node>();

	/** `callee` evaluates to the IPC invoke; it must be called directly. */
	const accept = (callee: ts.Node, what: string) => {
		if (!isCallee(callee)) return untraceable(callee, `${what} is not called directly`);
		const call = outermost(callee).parent as ts.CallExpression;
		calls.push({ line: line(call), arg: call.arguments[0] });
	};

	const bindName = (name: ts.Identifier, into: Set<string>) => {
		into.add(name.text);
		declarations.add(name);
	};

	const bindDynamic = (node: ts.CallExpression) => {
		const outer = outermost(node);
		const parent = outer.parent;
		const invoke = member(node, 'invoke');
		if (invoke) return accept(invoke, `(await import('${CORE_MODULE}')).invoke`);
		if (!ts.isVariableDeclaration(parent) || parent.initializer !== outer) {
			return untraceable(node, `import('${CORE_MODULE}') consumed some other way`);
		}
		if (ts.isIdentifier(parent.name)) return bindName(parent.name, namespaces);
		if (!ts.isObjectBindingPattern(parent.name)) {
			return untraceable(parent.name, `array destructuring of ${CORE_MODULE}`);
		}
		for (const element of parent.name.elements) {
			const imported = element.propertyName ?? element.name;
			if (element.dotDotDotToken) untraceable(element, `rest destructuring of ${CORE_MODULE}`);
			else if (!ts.isIdentifier(imported)) untraceable(element, 'computed destructuring key');
			else if (imported.text !== 'invoke') continue;
			else if (ts.isIdentifier(element.name)) bindName(element.name, invokeNames);
			else untraceable(element, 'nested destructuring of invoke');
		}
	};

	const bind = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			if (node.moduleSpecifier.text !== CORE_MODULE || !clause || clause.isTypeOnly) return;
			if (clause.name) untraceable(clause.name, `default import of ${CORE_MODULE}`);
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) bindName(bindings.name, namespaces);
			for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
				const imported = element.propertyName ?? element.name;
				if (imported.text === 'invoke' && !element.isTypeOnly) bindName(element.name, invokeNames);
			}
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			if ((node.moduleSpecifier as ts.StringLiteral).text !== CORE_MODULE || node.isTypeOnly)
				return;
			const clause = node.exportClause;
			const exportsInvoke =
				!clause ||
				!ts.isNamedExports(clause) ||
				clause.elements.some((e) => (e.propertyName ?? e.name).getText(source) === 'invoke');
			if (exportsInvoke) untraceable(node, `re-export from ${CORE_MODULE}`);
		} else if (isCoreImport(node)) {
			bindDynamic(node);
		}
		ts.forEachChild(node, bind);
	};

	/** `node` refers to a Tauri global; accept only `.invoke(...)` / `.core.invoke(...)`. */
	const useGlobal = (node: ts.Node, name: string) => {
		if (inTypePosition(node)) return;
		const invoke =
			name === '__TAURI__'
				? (() => {
						const core = member(node, 'core');
						return core && member(core, 'invoke');
					})()
				: member(node, 'invoke');
		if (invoke) accept(invoke, `${name}.invoke`);
		else untraceable(node, `${name} used other than as ${name}.invoke(...)`);
	};

	const use = (node: ts.Node) => {
		if (ts.isIdentifier(node) && !declarations.has(node)) {
			const parent = node.parent;
			const isGlobalProperty = ts.isPropertyAccessExpression(parent) && parent.name === node;
			if (TAURI_GLOBALS.has(node.text) && (isGlobalProperty || !isNameOnly(node))) {
				useGlobal(isGlobalProperty ? parent : node, node.text);
			} else if (!isNameOnly(node) && !inTypePosition(node)) {
				if (invokeNames.has(node.text)) accept(node, `invoke (${node.text})`);
				else if (namespaces.has(node.text)) {
					const invoke = member(node, 'invoke');
					if (invoke) accept(invoke, `${node.text}.invoke`);
					else if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
						untraceable(node, `the ${CORE_MODULE} namespace ${node.text} used as a value`);
					}
				}
			}
		} else if (
			ts.isStringLiteralLike(node) &&
			TAURI_GLOBALS.has(node.text) &&
			ts.isElementAccessExpression(node.parent) &&
			node.parent.argumentExpression === node
		) {
			useGlobal(node.parent, node.text);
		}
		ts.forEachChild(node, use);
	};

	bind(source);
	use(source);
	// The two walks each find calls; report them in source order.
	calls.sort((a, b) => a.line - b.line);
	problems.sort((a, b) => a.line - b.line);
	return { calls, problems };
}
