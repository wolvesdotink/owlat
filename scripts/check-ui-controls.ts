import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * One way to build a form control in the dashboard (docs/web-ui.md).
 *
 * Buttons come from `<UiButton>`, which composes the `.btn` recipe. Fields get
 * their look from the `.input` recipe in packages/ui/assets/css/components.css,
 * which `<UiInput>`, `<UiTextarea>` and the `<UiSelect>` trigger compose and a
 * native `<input>`, `<select>` or `<textarea>` carries directly. This gate keeps
 * the template side of that contract:
 *
 * - no raw `.btn` class: use `<UiButton>`;
 * - every native text control carries `input` (a field) or `input-bare` (a
 *   control inside a surface that draws the field itself), so nobody hand-rolls
 *   the field chrome again;
 * - an element carrying either recipe adds layout, not chrome: no background,
 *   border, radius, shadow, ring or outline, and on `input` no padding beyond
 *   one-sided room for an icon or action and no font size, which belong to
 *   `input` / `input-sm`;
 * - `class` on `<UiInput>`, `<UiTextarea>` or `<UiSelect>` places the
 *   component's container, so it carries no chrome either.
 */

const workspace = join(import.meta.dirname, '..');
const root = join(workspace, 'apps', 'web', 'app');

/**
 * Every `class` / `:class` attribute value in the source, static or bound.
 *
 * `(?<![\w:-])` keeps `data-class=`, `wrapper-class=` and the like out while
 * still admitting the `:`/`v-bind:` shorthands, and the value is matched across
 * newlines so an attribute the formatter wrapped is still read as one value.
 */
const CLASS_ATTRIBUTE = /(?<![\w:-])(:|v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * `btn` as a WHOLE class token — the design-system base class that
 * `<UiButton>` owns (packages/ui/components/ui/Button.vue composes `btn` with
 * its `btn-*` modifiers).
 *
 * The boundary is "anything that cannot continue a class name": not a word
 * character and not a hyphen, so the bound forms count as well:
 * `:class="on ? 'btn' : ''"`, `:class="['btn', size]"`, `:class="{ btn: on }"`
 * all ship the same class, and a gate blind to them is one refactor away from
 * bypassable.
 *
 * `btn-primary`, `tb-btn` and `tb_btn` are deliberately NOT this token. A
 * `btn-*` modifier does nothing without the base class beside it, so catching
 * the base catches the violation, and demanding more would flag unrelated
 * component classes that merely contain `btn`.
 */
const BTN_TOKEN = /(?<![\w-])btn(?![\w-])/;

/** The field recipe and the bare variant, as whole class tokens. */
const FIELD = 'input';
const BARE = 'input-bare';

/**
 * `<input>` types that are not text fields. A checkbox, radio, range, colour or
 * file input has its own geometry, and the button-like types are buttons.
 * Every other type, and an absent one, renders a text box.
 */
const NON_TEXT_TYPES = new Set([
	'checkbox',
	'radio',
	'range',
	'color',
	'file',
	'hidden',
	'submit',
	'button',
	'reset',
	'image',
]);

/** The components whose `class` lands on a container, not on the control. */
const FIELD_COMPONENTS = /^(?:UiInput|UiTextarea|UiSelect|ui-input|ui-textarea|ui-select)$/;

/** Utilities that draw a field's chrome, on any element carrying a recipe. */
const CHROME = /^(?:bg|border|rounded|shadow|ring|outline)(?:-|$)|^surface-\d/;

/**
 * Utilities that size a field: `input` and `input-sm` own its padding and font
 * size. One-sided padding (`pl-10`, `pr-8`, `pb-8`, `ps-*`, …) stays open: it
 * makes room for an icon or an action drawn over the field, not a new size.
 */
const FIELD_SIZE = /^p[xy]?-|^text-(?:xs|sm|base|lg|\d?xl)(?:\/|$)/;

type Token = { name: string; base: string };

/**
 * Blank `<script>` and `<style>` blocks, HTML comments and `{{ }}`
 * interpolations, keeping every newline so offsets still map to lines. What is
 * left is the template markup, where a `<` followed by a letter opens a tag.
 */
function templateOnly(source: string): string {
	const blank = (text: string) => text.replace(/[^\n]/g, ' ');
	return source
		.replace(/<script\b[\s\S]*?<\/script>/g, blank)
		.replace(/<style\b[\s\S]*?<\/style>/g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\{\{[\s\S]*?\}\}/g, blank);
}

type Tag = { name: string; text: string; index: number };

/** Every opening tag in the markup, read to its `>` with quoted values skipped. */
function* openingTags(markup: string): Generator<Tag> {
	for (const match of markup.matchAll(/<([A-Za-z][\w.-]*)/g)) {
		let at = match.index + match[0].length;
		let quote: string | null = null;
		for (; at < markup.length; at += 1) {
			const char = markup[at];
			if (quote) {
				if (char === quote) quote = null;
			} else if (char === '"' || char === "'") quote = char;
			else if (char === '>') break;
		}
		yield { name: match[1] ?? '', text: markup.slice(match.index, at + 1), index: match.index };
	}
}

/**
 * The class tokens an element ships. A static value is a list of classes. A
 * bound value is an expression, so its classes are the contents of its string
 * literals plus the bare keys of object literals (`{ input: on }`); an
 * identifier such as `inputClass` is opaque and contributes nothing, which is
 * why a recipe must be spelled out where the element is.
 */
function classTokens(tag: string): Token[] {
	const names: string[] = [];
	for (const match of tag.matchAll(CLASS_ATTRIBUTE)) {
		const value = match[2] ?? match[3] ?? '';
		if (!match[1]) {
			names.push(...value.split(/\s+/));
			continue;
		}
		for (const literal of value.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
			const text = (literal[1] ?? literal[2] ?? literal[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
			names.push(...text.split(/\s+/));
		}
		for (const key of value.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)) names.push(key[1] ?? '');
	}
	return names.filter(Boolean).map((name) => ({ name, base: utility(name) }));
}

/** `hover:!bg-x` → `bg-x`: the utility under its variants and `!` important. */
function utility(token: string): string {
	let depth = 0;
	let start = 0;
	for (let at = 0; at < token.length; at += 1) {
		const char = token[at];
		if (char === '[') depth += 1;
		else if (char === ']') depth -= 1;
		else if (char === ':' && depth === 0) start = at + 1;
	}
	return token.slice(start).replace(/^!|!$/g, '');
}

/** Whether a native `<input>` renders a text box, read from its `type`. */
function isTextInput(tag: string): boolean {
	const fixed = /(?<![\w:-])type\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	if (fixed) return !NON_TEXT_TYPES.has((fixed[1] ?? fixed[2] ?? '').trim().toLowerCase());
	const bound = /(?<![\w-])(?::|v-bind:)type\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	if (!bound) return true;
	// A bound type is a text box unless every type it can name is a non-text
	// one. An expression that names none (`:type="kind"`) cannot be proved
	// either way, so it is held to the stricter rule.
	const literals = [...(bound[1] ?? bound[2] ?? '').matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map(
		(literal) => (literal[1] ?? literal[2] ?? literal[3] ?? '').trim().toLowerCase()
	);
	return literals.length === 0 || literals.some((type) => !NON_TEXT_TYPES.has(type));
}

function isNativeTextControl(tag: Tag): boolean {
	const name = tag.name.toLowerCase();
	if (name === 'select' || name === 'textarea') return true;
	return name === 'input' && isTextInput(tag.text);
}

async function vueFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return vueFiles(path);
			return entry.name.endsWith('.vue') ? [path] : [];
		})
	);
	return nested.flat();
}

/** 1-based line of an offset, so a whole-file match still reports a location. */
function lineOf(source: string, index: number): number {
	let line = 1;
	for (let at = 0; at < index; at += 1) if (source[at] === '\n') line += 1;
	return line;
}

const rawButtons: string[] = [];
const unstyledFields: string[] = [];
const restyledFields: string[] = [];

for (const file of (await vueFiles(root)).sort()) {
	const source = await readFile(file, 'utf8');
	const path = relative(workspace, file);

	for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
		const value = match[2] ?? match[3] ?? '';
		if (BTN_TOKEN.test(value)) rawButtons.push(`${path}:${lineOf(source, match.index)}`);
	}

	for (const tag of openingTags(templateOnly(source))) {
		const at = () => `${path}:${lineOf(source, tag.index)}`;
		const tokens = classTokens(tag.text);
		const names = new Set(tokens.map((token) => token.name));
		const field = names.has(FIELD);
		const bare = names.has(BARE);

		if (isNativeTextControl(tag) && !field && !bare) {
			unstyledFields.push(`${at()} <${tag.name}>`);
			continue;
		}

		let offending: Token[] = [];
		if (field || bare) {
			offending = tokens.filter(
				(token) => CHROME.test(token.base) || (field && FIELD_SIZE.test(token.base))
			);
		} else if (FIELD_COMPONENTS.test(tag.name)) {
			offending = tokens.filter((token) => CHROME.test(token.base));
		}
		if (offending.length > 0) {
			const list = [...new Set(offending.map((token) => token.name))].join(' ');
			restyledFields.push(`${at()} <${tag.name}> ${list}`);
		}
	}
}

const sections: Array<[string, string[]]> = [
	['Use <UiButton> instead of raw .btn classes:', rawButtons],
	[
		'Give native text controls the field recipe: class="input", or class="input-bare" inside a surface that draws the field:',
		unstyledFields,
	],
	[
		'Do not restyle a field: chrome and size come from .input / .input-sm, so add layout classes only and put any other chrome on a wrapper:',
		restyledFields,
	],
];

let failed = false;
for (const [heading, lines] of sections) {
	if (lines.length === 0) continue;
	failed = true;
	console.error(heading);
	console.error(lines.join('\n'));
}

if (failed) {
	console.error('See docs/web-ui.md.');
	process.exit(1);
}
