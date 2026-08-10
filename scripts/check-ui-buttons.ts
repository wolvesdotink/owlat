import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const workspace = join(import.meta.dirname, '..');
const root = join(workspace, 'apps', 'web', 'app');

/**
 * Every `class` / `:class` attribute value in the source, static or bound.
 *
 * `(?<![\w:-])` keeps `data-class=`, `wrapper-class=` and the like out while
 * still admitting the `:`/`v-bind:` shorthands, and the value is matched across
 * newlines so an attribute the formatter wrapped is still read as one value.
 */
const CLASS_ATTRIBUTE = /(?<![\w:-])(?::|v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * `btn` as a WHOLE class token — the design-system base class that
 * `<UiButton>` owns (packages/ui/components/ui/Button.vue composes `btn` with
 * its `btn-*` modifiers).
 *
 * The boundary is "anything that cannot continue a class name" — not a word
 * character and not a hyphen — which is what the old
 * `class="[^"]*(?:^|\s)btn(?:\s|$)"` shape got wrong in both directions: `^`
 * could never match after `class="` was consumed, and `(?:\s|$)` never reached
 * the closing quote, so `class="btn btn-primary"` and `class="foo btn"` both
 * passed and only a mid-string `btn` was caught.
 *
 * Spelling it as a boundary rather than as whitespace is what makes the bound
 * forms count as well — `:class="on ? 'btn' : ''"`, `:class="['btn', size]"`,
 * `:class="{ btn: isPrimary }"` all ship the same class, and a gate blind to
 * them is one refactor away from bypassable.
 *
 * `btn-primary`, `tb-btn` and `tb_btn` are deliberately NOT this token. A
 * `btn-*` modifier does nothing without the base class beside it, so catching
 * the base catches the violation, and demanding more would flag unrelated
 * component classes that merely contain `btn`.
 */
const BTN_TOKEN = /(?<![\w-])btn(?![\w-])/;

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

const violations: string[] = [];
for (const file of await vueFiles(root)) {
	const source = await readFile(file, 'utf8');
	for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
		const value = match[1] ?? match[2] ?? '';
		if (!BTN_TOKEN.test(value)) continue;
		violations.push(`${relative(workspace, file)}:${lineOf(source, match.index)}`);
	}
}

if (violations.length > 0) {
	console.error('Use <UiButton> instead of raw .btn classes:');
	console.error(violations.join('\n'));
	process.exit(1);
}
