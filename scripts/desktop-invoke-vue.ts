/**
 * Single-file components for scripts/desktop-invoke-scan.ts.
 *
 * A template can call anything its `<script setup>` declares or imports
 * (`<button @click="invoke('removed_command')">`) or hand it to a child
 * (`<Child :fn="invoke" />`), so scanning only the script misses real calls.
 * Each SFC is turned into one source the scanner reads whole: its script
 * blocks as written, followed by the template compiled with
 * `compileTemplate({ inline: true })` and the script's top-level bindings as
 * `bindingMetadata`. That is the render function `compileScript` inlines into
 * `setup()` for the app build: a setup binding is referenced by name (an
 * import as `_unref(invoke)`), anything else as `_ctx.name`. Without
 * `<script setup>` the template is compiled normally; it can then only reach
 * `_ctx` members, and the script itself carries any taint.
 *
 * `compileScript` itself is not used: type-based `defineProps<T>()` makes it
 * resolve `T`'s imports through Nuxt's generated tsconfig (`~/...` aliases),
 * which a lint run does not have, and the scan does not need prop types.
 *
 * Each finding maps back to its `.vue` line: script lines by their block's
 * offset, template lines through the compiler's source map (the template's
 * first line when a position has no mapping). An SFC that does not parse or
 * whose template does not compile is itself a finding: the gate cannot vouch
 * for code it cannot read.
 */
import { createHash } from 'node:crypto';
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';
import ts from 'typescript';
import { syntaxErrors } from './desktop-invoke-scan';
import {
	type BindingMetadata,
	compileTemplate,
	parse,
	type SFCScriptBlock,
} from 'vue/compiler-sfc';

/** One compiled piece of an SFC and how its positions map back to the file. */
export interface CompiledPart {
	readonly text: string;
	/** 1-based `.vue` line for a 0-based line and column of `text`. */
	readonly lineOf: (line: number, column: number) => number;
	/** Its syntax was already checked piece by piece; the joined text is not. */
	readonly syntaxChecked?: boolean;
}

export interface CompiledSfc {
	readonly parts: CompiledPart[];
	readonly problems: { line: number; message: string }[];
}

/** Every top-level value binding a script block declares or imports. */
function scriptBindings(content: string, into: BindingMetadata): void {
	const source = ts.createSourceFile('block.ts', content, ts.ScriptTarget.Latest, true);
	const bindName = (name: ts.BindingName) => {
		if (ts.isIdentifier(name)) into[name.text] = 'setup-maybe-ref' as BindingMetadata[string];
		else
			for (const element of name.elements)
				if (!ts.isOmittedExpression(element)) bindName(element.name);
	};
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || clause.isTypeOnly) continue;
			if (clause.name) bindName(clause.name);
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) bindName(bindings.name);
			for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
				if (!element.isTypeOnly) bindName(element.name);
			}
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) bindName(declaration.name);
		} else if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name
		) {
			bindName(statement.name);
		}
	}
}

export function compileSfc(raw: string, file: string): CompiledSfc {
	const problems: CompiledSfc['problems'] = [];
	const unreadable = (line: number, why: string) =>
		problems.push({
			line,
			message: `untraceable invoke use: the component does not compile (${why})`,
		});
	const { descriptor, errors } = parse(raw, { filename: file, sourceMap: true });
	const [parseError] = errors;
	if (parseError) {
		unreadable('loc' in parseError ? (parseError.loc?.start.line ?? 1) : 1, parseError.message);
		return { parts: [], problems };
	}
	const { script, scriptSetup, template } = descriptor;
	const blocks = [script, scriptSetup].filter((block): block is SFCScriptBlock => block !== null);

	// The combined text, and for each of its lines where that line came from.
	let text = '';
	const origins: ((column: number) => number)[] = [];
	const append = (chunk: string, origin: (line: number, column: number) => number) => {
		const lines = chunk.split('\n');
		for (let line = 0; line < lines.length; line += 1) {
			origins.push((column) => origin(line, column));
		}
		text += `${chunk}\n`;
	};
	const bindingMetadata: BindingMetadata = {};
	for (const block of blocks) {
		// A block's content starts on its opening tag's line. Its syntax is
		// checked on its own: joined to the next block, `const x =` would just
		// take that block's first statement as its value.
		const kind =
			block.lang === 'tsx' || block.lang === 'jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const alone = ts.createSourceFile(file, block.content, ts.ScriptTarget.Latest, true, kind);
		// An error at the end of the block (an unclosed comment) stays on its
		// last line of code instead of the closing tag's or the template's.
		const lastLine = Math.max(0, block.content.trimEnd().split('\n').length - 1);
		problems.push(
			...syntaxErrors(alone, (line) => block.loc.start.line + Math.min(line, lastLine))
		);
		append(block.content, (line) => block.loc.start.line + line);
		// Both blocks' top-level bindings reach a `<script setup>` template.
		if (scriptSetup) scriptBindings(block.content, bindingMetadata);
	}
	if (template) {
		const isTS = blocks.some((block) => block.lang === 'ts' || block.lang === 'tsx');
		const out = compileTemplate({
			source: template.content,
			filename: file,
			id: createHash('sha256').update(file).digest('hex').slice(0, 8),
			compilerOptions: scriptSetup ? { inline: true, bindingMetadata, isTS } : { isTS },
		});
		const [templateError] = out.errors;
		if (templateError) {
			const message = typeof templateError === 'string' ? templateError : templateError.message;
			// The error's location is relative to the template block's content.
			const at = typeof templateError === 'string' ? undefined : templateError.loc?.start.line;
			unreadable(at ? template.loc.start.line + at - 1 : template.loc.start.line, message);
		} else {
			const consumer = out.map ? new SourceMapConsumer(out.map as RawSourceMap) : undefined;
			// The template map is relative to the block's content.
			const offset = template.loc.start.line - 1;
			const templateLine = (line: number, column: number) => {
				const original = consumer?.originalPositionFor({ line: line + 1, column });
				return original?.line ? original.line + offset : template.loc.start.line;
			};
			const rendered = ts.createSourceFile(
				file,
				out.code,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			problems.push(...syntaxErrors(rendered, templateLine));
			// Inline mode yields one render arrow (wrapped to stand as a statement);
			// otherwise a module with its own imports and `export function render`.
			append(scriptSetup ? `;(${out.code});` : out.code, templateLine);
		}
	}
	const lineOf = (line: number, column: number) =>
		origins[line]?.(column) ?? template?.loc.start.line ?? 1;
	return { parts: text ? [{ text, lineOf, syntaxChecked: true }] : [], problems };
}
