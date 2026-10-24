/**
 * Which function a name stands for, for the action commit census
 * (`actionCommits.ts`): the census follows a helper only when it can tell
 * which function a call or a callback argument names.
 */
import ts from 'typescript';

export type FunctionLike = ts.FunctionLikeDeclaration;

export function isFunctionLiteral(node: ts.Node): node is FunctionLike {
	return (
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

/** Aliases (`const run = persist`) followed before a name is given up on. */
const MAX_ALIASES = 8;

/**
 * The function `name` stands for where it is written, found the way
 * JavaScript scoping finds it: the nearest enclosing block, function or module
 * that declares the name. A parameter, a non-function binding or an import
 * shadows it and resolves to nothing; `const run = persist` is followed to
 * `persist`. Resolution depends only on where the name is written, so a helper
 * declared in a handler is found from every closure nested in that handler.
 */
export function resolveFunction(name: ts.Identifier): FunctionLike | undefined {
	return resolveName(name.text, name, 0);
}

function resolveName(name: string, site: ts.Node, aliases: number): FunctionLike | undefined {
	for (let scope = site.parent; scope; scope = scope.parent) {
		if (isFunctionLiteral(scope)) {
			if (scope.parameters.some((parameter) => bindsName(parameter.name, name))) return undefined;
			if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope;
		}
		if (ts.isCatchClause(scope) && scope.variableDeclaration) {
			if (bindsName(scope.variableDeclaration.name, name)) return undefined;
		}
		if (
			(ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
			scope.initializer &&
			ts.isVariableDeclarationList(scope.initializer) &&
			scope.initializer.declarations.some((declaration) => bindsName(declaration.name, name))
		) {
			return undefined;
		}
		for (const statement of scopeStatements(scope)) {
			const binding = declarationOf(statement, name);
			if (binding === undefined) continue;
			if (binding === SHADOWED) return undefined;
			if (isFunctionLiteral(binding)) return binding;
			return aliases < MAX_ALIASES ? resolveName(binding.text, binding, aliases + 1) : undefined;
		}
	}
	return undefined;
}

const SHADOWED = 'shadowed';

/** The statements declared directly in `scope`, if it is a block-like scope. */
function scopeStatements(scope: ts.Node): readonly ts.Statement[] {
	if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
		return scope.statements;
	}
	if (ts.isCaseBlock(scope)) return scope.clauses.flatMap((clause) => [...clause.statements]);
	return [];
}

/**
 * What `statement` binds `name` to: a function, an identifier it aliases,
 * `SHADOWED` for any other binding, or `undefined` when it does not bind it.
 */
function declarationOf(
	statement: ts.Statement,
	name: string
): FunctionLike | ts.Identifier | typeof SHADOWED | undefined {
	if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
	if (ts.isClassDeclaration(statement) && statement.name?.text === name) return SHADOWED;
	if (!ts.isVariableStatement(statement)) return undefined;
	for (const declaration of statement.declarationList.declarations) {
		if (!bindsName(declaration.name, name)) continue;
		const init = declaration.initializer;
		if (!ts.isIdentifier(declaration.name) || !init) return SHADOWED;
		if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isIdentifier(init)) {
			return init;
		}
		return SHADOWED;
	}
	return undefined;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
	if (ts.isIdentifier(binding)) return binding.text === name;
	return binding.elements.some(
		(element) => !ts.isOmittedExpression(element) && bindsName(element.name, name)
	);
}
