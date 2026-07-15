import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { RepositoryModuleAlias } from './repositoryAliases';

export interface FrameworkStaticValues {
	readonly bindingCounts: ReadonlyMap<string, number>;
	readonly configDirectory: string;
	readonly constants: ReadonlyMap<string, ts.Expression>;
	readonly fileUrlToPathBindings: ReadonlySet<string>;
	readonly mutatedBindings: ReadonlySet<string>;
	readonly pathDirnameBindings: ReadonlySet<string>;
	readonly pathResolveBindings: ReadonlySet<string>;
}

export function readFrameworkAliasFind(
	value: ts.Expression,
	staticValues: FrameworkStaticValues
): Pick<RepositoryModuleAlias, 'matchKind' | 'specifierPattern'> {
	if (!ts.isRegularExpressionLiteral(value)) {
		return {
			matchKind: 'prefix',
			specifierPattern: readFrameworkStaticString(value, staticValues),
		};
	}
	const match = /^\/(.*)\/([a-z]*)$/.exec(value.text);
	if (!match || match[2] !== '') {
		throw new Error('Framework RegExp aliases must be exact and case-sensitive');
	}
	const body = match[1]!;
	if (!body.startsWith('^') || !body.endsWith('$')) {
		throw new Error('Framework RegExp aliases must anchor one exact module specifier');
	}
	return {
		matchKind: 'exact',
		specifierPattern: decodeExactRegExpLiteral(body.slice(1, -1)),
	};
}

export function readFrameworkStaticValues(sourceFile: ts.SourceFile): FrameworkStaticValues {
	const bindingCounts = new Map<string, number>();
	const constants = new Map<string, ts.Expression>();
	const fileUrlToPathCandidates = new Set<string>();
	const pathDirnameCandidates = new Set<string>();
	const pathResolveCandidates = new Set<string>();
	const mutatedBindings = new Set<string>();
	const countBinding = (name: string): void => {
		bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
	};
	const countBindingName = (name: ts.BindingName): void => {
		if (ts.isIdentifier(name)) {
			countBinding(name.text);
			return;
		}
		for (const element of name.elements) {
			if (!ts.isOmittedExpression(element)) countBindingName(element.name);
		}
	};

	const visitBindings = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
			ts.isIdentifier(node.left)
		) {
			mutatedBindings.add(node.left.text);
		}
		if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken ||
				node.operator === ts.SyntaxKind.MinusMinusToken) &&
			ts.isIdentifier(node.operand)
		) {
			mutatedBindings.add(node.operand.text);
		}
		if (ts.isVariableDeclaration(node)) countBindingName(node.name);
		else if (ts.isParameter(node)) countBindingName(node.name);
		else if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isEnumDeclaration(node)) &&
			node.name
		) {
			countBinding(node.name.text);
		} else if (ts.isImportClause(node)) {
			if (node.name) countBinding(node.name.text);
		} else if (ts.isNamespaceImport(node)) {
			countBinding(node.name.text);
		} else if (ts.isImportSpecifier(node)) {
			countBinding(node.name.text);
		}
		ts.forEachChild(node, visitBindings);
	};
	visitBindings(sourceFile);

	for (const statement of sourceFile.statements) {
		if (
			ts.isVariableStatement(statement) &&
			(statement.declarationList.flags & ts.NodeFlags.Const) !== 0
		) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer) {
					constants.set(declaration.name.text, declaration.initializer);
				}
			}
		}
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			const moduleSpecifier = statement.moduleSpecifier.text;
			for (const element of statement.importClause.namedBindings.elements) {
				const importedName = (element.propertyName ?? element.name).text;
				if (['node:path', 'path'].includes(moduleSpecifier) && importedName === 'resolve') {
					pathResolveCandidates.add(element.name.text);
				}
				if (['node:path', 'path'].includes(moduleSpecifier) && importedName === 'dirname') {
					pathDirnameCandidates.add(element.name.text);
				}
				if (['node:url', 'url'].includes(moduleSpecifier) && importedName === 'fileURLToPath') {
					fileUrlToPathCandidates.add(element.name.text);
				}
			}
		}
	}

	const uniqueCandidates = (candidates: ReadonlySet<string>): ReadonlySet<string> =>
		new Set(
			[...candidates].filter((name) => bindingCounts.get(name) === 1 && !mutatedBindings.has(name))
		);
	return {
		bindingCounts,
		configDirectory: dirname(sourceFile.fileName),
		constants: new Map(
			[...constants].filter(([name]) => bindingCounts.get(name) === 1 && !mutatedBindings.has(name))
		),
		fileUrlToPathBindings: uniqueCandidates(fileUrlToPathCandidates),
		mutatedBindings,
		pathDirnameBindings: uniqueCandidates(pathDirnameCandidates),
		pathResolveBindings: uniqueCandidates(pathResolveCandidates),
	};
}

export function readFrameworkStaticString(
	value: ts.Expression,
	staticValues: FrameworkStaticValues,
	resolving = new Set<string>()
): string {
	const expression = unwrapTypeOnlyExpression(value);
	const literal = readStaticString(expression);
	if (literal !== undefined) return literal;
	if (ts.isIdentifier(expression)) {
		const initializer = staticValues.constants.get(expression.text);
		if (!initializer || resolving.has(expression.text)) {
			throw new Error('Framework alias values must be statically resolvable constants');
		}
		const nextResolving = new Set(resolving).add(expression.text);
		return readFrameworkStaticString(initializer, staticValues, nextResolving);
	}
	if (
		ts.isCallExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		staticValues.pathResolveBindings.has(expression.expression.text) &&
		expression.arguments.length >= 1 &&
		isSafeConfigDirectory(expression.arguments[0]!, staticValues)
	) {
		const parts = expression.arguments
			.slice(1)
			.map((argument) => readFrameworkStaticString(argument, staticValues, resolving));
		return resolve(staticValues.configDirectory, ...parts);
	}
	throw new Error('Framework alias values must be static strings or safe path.resolve calls');
}

function isSafeConfigDirectory(value: ts.Expression, staticValues: FrameworkStaticValues): boolean {
	const expression = unwrapTypeOnlyExpression(value);
	if (!ts.isIdentifier(expression) || expression.text !== '__dirname') return false;
	if (!staticValues.bindingCounts.has('__dirname')) {
		return !staticValues.mutatedBindings.has('__dirname');
	}
	const initializer = staticValues.constants.get('__dirname');
	return initializer ? isCanonicalEsmDirectory(initializer, staticValues) : false;
}

function isCanonicalEsmDirectory(
	value: ts.Expression,
	staticValues: FrameworkStaticValues
): boolean {
	const expression = unwrapTypeOnlyExpression(value);
	if (
		isImportedCall(expression, staticValues.pathDirnameBindings, (argument) =>
			isCanonicalEsmFilename(argument, staticValues)
		)
	) {
		return true;
	}
	return isImportedCall(expression, staticValues.fileUrlToPathBindings, (argument) => {
		const url = unwrapTypeOnlyExpression(argument);
		return (
			ts.isNewExpression(url) &&
			ts.isIdentifier(url.expression) &&
			url.expression.text === 'URL' &&
			!staticValues.bindingCounts.has('URL') &&
			!staticValues.mutatedBindings.has('URL') &&
			url.arguments?.length === 2 &&
			readStaticString(unwrapTypeOnlyExpression(url.arguments[0]!)) === '.' &&
			isImportMetaUrl(url.arguments[1]!)
		);
	});
}

function isCanonicalEsmFilename(
	value: ts.Expression,
	staticValues: FrameworkStaticValues,
	resolving = new Set<string>()
): boolean {
	const expression = unwrapTypeOnlyExpression(value);
	if (ts.isIdentifier(expression)) {
		const initializer = staticValues.constants.get(expression.text);
		if (!initializer || resolving.has(expression.text)) return false;
		return isCanonicalEsmFilename(
			initializer,
			staticValues,
			new Set(resolving).add(expression.text)
		);
	}
	return isImportedCall(expression, staticValues.fileUrlToPathBindings, isImportMetaUrl);
}

function isImportedCall(
	value: ts.Expression,
	bindings: ReadonlySet<string>,
	acceptArgument: (argument: ts.Expression) => boolean
): boolean {
	const expression = unwrapTypeOnlyExpression(value);
	return (
		ts.isCallExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		bindings.has(expression.expression.text) &&
		expression.arguments.length === 1 &&
		acceptArgument(expression.arguments[0]!)
	);
}

function isImportMetaUrl(value: ts.Expression): boolean {
	const expression = unwrapTypeOnlyExpression(value);
	return (
		ts.isPropertyAccessExpression(expression) &&
		expression.name.text === 'url' &&
		ts.isMetaProperty(expression.expression) &&
		expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		expression.expression.name.text === 'meta'
	);
}

function unwrapTypeOnlyExpression(value: ts.Expression): ts.Expression {
	let expression = value;
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		expression = expression.expression;
	}
	return expression;
}

function decodeExactRegExpLiteral(source: string): string {
	let literal = '';
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (character === '\\') {
			const escaped = source[++index];
			if (!escaped || !/[\\/\-.$^*+?()[\]{}|]/.test(escaped)) {
				throw new Error('Framework RegExp alias contains a non-literal escape');
			}
			literal += escaped;
		} else {
			if (/[.$^*+?()[\]{}|]/.test(character)) {
				throw new Error('Framework RegExp alias must not contain pattern operators');
			}
			literal += character;
		}
	}
	return literal;
}

function readStaticString(value: ts.Expression): string | undefined {
	return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
		? value.text
		: undefined;
}
