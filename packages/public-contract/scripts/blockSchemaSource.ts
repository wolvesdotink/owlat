/**
 * Build the JSON Schema of block content from the block types in
 * `@owlat/shared` (`packages/shared/src/types/blocks.ts`), read with the
 * TypeScript compiler. The types are the one definition of a block: the
 * editor, the renderer and the backend all import them, so a schema built
 * from them cannot describe a field nothing else knows.
 *
 * What the generator reads from the types:
 * - every block type and its content interface, from `BlockTypeContentMap`
 * - field types, string and number literal unions as enums, arrays and the
 *   named helper interfaces (each one a `$defs` entry)
 * - required fields: a field without `?` is required, unless its doc comment
 *   carries `@writeOptional`, which marks a field the types require but a
 *   write accepts without (the renderer's validator does not refuse it and
 *   the render falls back to the theme). The schema tests check each
 *   required field against the validator.
 * - descriptions: the first paragraph of each doc comment; a field without
 *   one takes the comment of the same field on `CommonBlockProperties`
 * - examples: one per block type, from `blockExamples.ts`
 * - nesting: an interface with a `type` union of block types and a `content`
 *   field (`ColumnItem`, `ContainerItem`) becomes a choice between those
 *   block types.
 *
 * This module runs at generation and test time only. It needs the compiler,
 * so nothing that ships imports it; the committed `schemas/blocks.json` is
 * what the API serves.
 */

import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { BLOCK_EXAMPLES } from './blockExamples';

type JsonObject = Record<string, unknown>;

export const BLOCK_SCHEMA_ID = 'https://docs.owlat.app/schemas/blocks.json';

const TYPES_FILE = fileURLToPath(new URL('../../shared/src/types/blocks.ts', import.meta.url));

/** The doc-comment tag that relaxes a field the types require. */
const WRITE_OPTIONAL_TAG = 'writeOptional';

/** Each block type's `$defs` name: `TextBlockContent` → `TextBlock`. */
const blockDefName = (contentInterface: string): string => contentInterface.replace(/Content$/, '');

interface Generator {
	checker: ts.TypeChecker;
	defs: Map<string, JsonObject>;
	/** Content interface name → block type, for the nesting unions. */
	blockDefByType: Map<string, string>;
	commonDocs: Map<string, string>;
}

function firstParagraph(text: string): string {
	return (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
}

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
	return firstParagraph(ts.displayPartsToString(symbol.getDocumentationComment(checker)));
}

function hasTag(symbol: ts.Symbol, tag: string): boolean {
	return symbol.getJsDocTags().some((t) => t.name === tag);
}

function isOptional(symbol: ts.Symbol): boolean {
	return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

/** The type without `undefined`, which an optional field's type carries. */
function defined(type: ts.Type): ts.Type[] {
	const parts = type.isUnion() ? type.types : [type];
	return parts.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
}

function literalSchema(parts: ts.Type[]): JsonObject | undefined {
	if (parts.length > 0 && parts.every((t) => t.isStringLiteral())) {
		return { type: 'string', enum: parts.map((t) => (t as ts.StringLiteralType).value) };
	}
	if (parts.length > 0 && parts.every((t) => t.isNumberLiteral())) {
		const values = parts.map((t) => (t as ts.NumberLiteralType).value);
		return { type: values.every(Number.isInteger) ? 'integer' : 'number', enum: values };
	}
	return undefined;
}

/** A named interface or alias the generator gives its own `$defs` entry. */
function namedObject(type: ts.Type): string | undefined {
	const symbol = type.aliasSymbol ?? type.getSymbol();
	if (!symbol || symbol.name === '__type' || symbol.name === '__object') return undefined;
	if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
	return symbol.name;
}

function schemaFor(gen: Generator, type: ts.Type, where: string): JsonObject {
	const { checker } = gen;
	const parts = defined(type);

	if (parts.length > 1 && parts.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) {
		return { type: 'boolean' };
	}
	const literal = literalSchema(parts);
	if (literal) return literal;
	if (parts.length !== 1) {
		throw new Error(`${where}: unions other than literal enums are not supported`);
	}
	const only = parts[0]!;
	if (only.flags & ts.TypeFlags.String) return { type: 'string' };
	if (only.flags & ts.TypeFlags.Number) return { type: 'number' };
	if (only.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
	if (checker.isArrayType(only)) {
		const [element] = checker.getTypeArguments(only as ts.TypeReference);
		if (!element) throw new Error(`${where}: array without an element type`);
		return { type: 'array', items: schemaFor(gen, element, `${where}[]`) };
	}
	if (only.flags & ts.TypeFlags.Object) {
		const name = namedObject(only);
		if (name) {
			defineNamed(gen, name, only);
			return { $ref: `#/$defs/${name}` };
		}
		return objectSchema(gen, only, where);
	}
	throw new Error(`${where}: unsupported type ${checker.typeToString(only)}`);
}

/**
 * The block types a nested item may be, when `type` is an object type with a
 * `type` field of block-type literals and a `content` field.
 */
function nestedBlockTypes(gen: Generator, type: ts.Type): string[] | undefined {
	const typeField = type.getProperty('type');
	if (!typeField || !type.getProperty('content') || !type.getProperty('id')) return undefined;
	const parts = defined(gen.checker.getTypeOfSymbol(typeField));
	if (!parts.every((t) => t.isStringLiteral())) return undefined;
	const values = parts.map((t) => (t as ts.StringLiteralType).value);
	return values.every((v) => gen.blockDefByType.has(v)) ? values : undefined;
}

function defineNamed(gen: Generator, name: string, type: ts.Type): void {
	if (gen.defs.has(name)) return;
	const nested = nestedBlockTypes(gen, type);
	const symbol = type.aliasSymbol ?? type.getSymbol();
	const description = symbol ? docOf(symbol, gen.checker) : '';
	if (nested) {
		gen.defs.set(name, {
			...(description && { description }),
			oneOf: nested.map((t) => ({ $ref: `#/$defs/${gen.blockDefByType.get(t)}` })),
		});
		return;
	}
	// Reserve the name first so a type that refers to itself ends in a $ref.
	gen.defs.set(name, {});
	gen.defs.set(name, {
		...(description && { description }),
		...objectSchema(gen, type, name),
	});
}

function objectSchema(gen: Generator, type: ts.Type, where: string): JsonObject {
	const { checker } = gen;
	const properties: JsonObject = {};
	const required: string[] = [];
	for (const field of checker.getPropertiesOfType(type)) {
		const declaration = field.valueDeclaration ?? field.declarations?.[0];
		if (!declaration) throw new Error(`${where}.${field.name}: no declaration`);
		const schema = schemaFor(
			gen,
			checker.getTypeOfSymbolAtLocation(field, declaration),
			`${where}.${field.name}`
		);
		const description = docOf(field, checker) || gen.commonDocs.get(field.name) || '';
		// 2020-12 applies keywords next to a `$ref`, so a description can sit beside one.
		properties[field.name] = description ? { description, ...schema } : schema;
		if (!isOptional(field) && !hasTag(field, WRITE_OPTIONAL_TAG)) required.push(field.name);
	}
	return {
		type: 'object',
		properties,
		...(required.length > 0 && { required }),
		additionalProperties: false,
	};
}

function exportedType(
	checker: ts.TypeChecker,
	exports: ts.Symbol[],
	name: string
): { symbol: ts.Symbol; type: ts.Type } {
	const symbol = exports.find((s) => s.name === name);
	if (!symbol) throw new Error(`blocks.ts exports no ${name}`);
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return { symbol: target, type: checker.getDeclaredTypeOfSymbol(target) };
}

function exampleOf(type: string): unknown {
	const example = (BLOCK_EXAMPLES as Record<string, unknown>)[type];
	if (!example) throw new Error(`blockExamples.ts has no example of a ${type} block`);
	return example;
}

/** Build the schema. Throws when the types hold a shape it cannot express. */
export function buildBlockContentSchema(): JsonObject {
	const program = ts.createProgram([TYPES_FILE], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(TYPES_FILE);
	const moduleSymbol = source && checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`cannot read ${TYPES_FILE}`);
	const exports = checker.getExportsOfModule(moduleSymbol);

	const contentMap = exportedType(checker, exports, 'BlockTypeContentMap').type;
	const common = exportedType(checker, exports, 'CommonBlockProperties').type;
	const savedBlockRef = exportedType(checker, exports, 'SavedBlockRef').type;

	const commonDocs = new Map<string, string>();
	for (const field of checker.getPropertiesOfType(common)) {
		const doc = docOf(field, checker);
		if (doc) commonDocs.set(field.name, doc);
	}

	const blockTypes = checker.getPropertiesOfType(contentMap).map((field) => {
		const content = checker.getTypeOfSymbol(field);
		const name = content.getSymbol()?.name;
		if (!name) throw new Error(`BlockTypeContentMap.${field.name} is not a named interface`);
		return { type: field.name, content, defName: blockDefName(name) };
	});

	const gen: Generator = {
		checker,
		defs: new Map(),
		blockDefByType: new Map(blockTypes.map((b) => [b.type, b.defName])),
		commonDocs,
	};

	const blockDefs = new Map<string, JsonObject>();
	for (const block of blockTypes) {
		const contentSymbol = block.content.getSymbol()!;
		const description = docOf(contentSymbol, checker);
		blockDefs.set(block.defName, {
			...(description && { description }),
			type: 'object',
			properties: {
				id: {
					description: 'Unique within the email. Translations and saved-block links key on it.',
					type: 'string',
					minLength: 1,
				},
				type: { const: block.type },
				content: objectSchema(gen, block.content, `${block.type}.content`),
				savedBlockRef: {
					description:
						'Set on the blocks of a linked saved block; a change to the saved block replaces them.',
					$ref: '#/$defs/SavedBlockRef',
				},
			},
			required: ['id', 'type', 'content'],
			additionalProperties: false,
			examples: [exampleOf(block.type)],
		});
	}
	defineNamed(gen, 'SavedBlockRef', savedBlockRef);

	const defs: JsonObject = {
		Block: {
			description: 'One block at the top level of an email. `type` decides the shape of `content`.',
			type: 'object',
			properties: { type: { enum: blockTypes.map((b) => b.type) } },
			required: ['type'],
			oneOf: blockTypes.map((b) => ({ $ref: `#/$defs/${b.defName}` })),
		},
	};
	for (const block of blockTypes) defs[block.defName] = blockDefs.get(block.defName);
	for (const name of [...gen.defs.keys()].sort()) defs[name] = gen.defs.get(name);

	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: BLOCK_SCHEMA_ID,
		title: 'Owlat block content',
		description:
			'The blocks of an email template, transactional email or saved block, in the order they render. Generated from the block types; fields a block does not list are refused.',
		type: 'array',
		items: { $ref: '#/$defs/Block' },
		$defs: defs,
	};
}

/** The schema as the committed file holds it, before formatting. */
export function serializeBlockContentSchema(schema: JsonObject): string {
	return `${JSON.stringify(schema, null, '\t')}\n`;
}
