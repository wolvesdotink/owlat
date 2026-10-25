/**
 * Every native `title` tooltip on an interactive element in the Vue templates,
 * one line per site, for scripts/check-native-title.sh to ratchet.
 *
 * A native title shows only after a long hover, never on keyboard focus or
 * touch, and cannot be styled; on a control it is a tooltip, and the tooltip
 * is UiTooltip (packages/ui/components/ui/Tooltip.vue). Elsewhere `title` is
 * metadata and stays: the full value of a truncated label on a `<span>`, an
 * iframe's accessible name, a dialog's heading prop (`<UiModal title>` is a
 * component prop, not an attribute on a control).
 *
 * An element counts as interactive when it is a control or link by tag
 * (`<button>`, `<a>`, form fields, `<summary>`, `<UiButton>`, `<NuxtLink>`)
 * or a native element made into one (a click handler, an interactive `role`,
 * a `tabindex`). A title that really is metadata on a control (a link whose
 * visible text is truncated) is kept by a comment right before the element
 * saying why: `<!-- native-title: the full address of a truncated link -->`.
 *
 * Lines are `path<TAB>tag<TAB>attribute`, with no line number, so editing
 * anything else in a file does not churn the baseline. Repeats are kept: two
 * identical sites in one file are two lines.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'vue/compiler-sfc';

const workspace = join(import.meta.dirname, '..');

export const NATIVE_TITLE_ROOTS = [
	'apps/web/app',
	'apps/marketing',
	'apps/docs',
	'packages/ui',
	'packages/email-builder/src',
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.nuxt', '.output', 'dist', '__tests__']);

const INTERACTIVE_TAGS = new Set([
	'a',
	'button',
	'input',
	'select',
	'textarea',
	'summary',
	'UiButton',
	'ui-button',
	'NuxtLink',
	'nuxt-link',
	'RouterLink',
	'router-link',
]);

const INTERACTIVE_ROLES = new Set([
	'button',
	'checkbox',
	'link',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'radio',
	'switch',
	'tab',
]);

const OPT_OUT = /^\s*native-title:\s*\S/;

// compiler-core NodeTypes and prop types, structurally.
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

interface TemplateProp {
	type: number;
	name: string;
	value?: { content: string };
	arg?: { content?: string };
	loc: { source: string };
}

interface TemplateNode {
	type: number;
	tag?: string;
	content?: unknown;
	props?: TemplateProp[];
	children?: TemplateNode[];
	branches?: TemplateNode[];
}

function staticAttribute(node: TemplateNode, name: string): string | undefined {
	return node.props?.find((prop) => prop.type === ATTRIBUTE && prop.name === name)?.value?.content;
}

function bound(prop: TemplateProp, name: string): boolean {
	return prop.type === DIRECTIVE && prop.name === 'bind' && prop.arg?.content === name;
}

function has(node: TemplateNode, name: string): boolean {
	return (
		node.props?.some(
			(prop) => (prop.type === ATTRIBUTE && prop.name === name) || bound(prop, name)
		) ?? false
	);
}

function titleOf(node: TemplateNode): TemplateProp | undefined {
	return node.props?.find(
		(prop) => (prop.type === ATTRIBUTE && prop.name === 'title') || bound(prop, 'title')
	);
}

function isInteractive(node: TemplateNode): boolean {
	const tag = node.tag ?? '';
	if (INTERACTIVE_TAGS.has(tag)) return true;
	// A component's own `title` prop is its business (a dialog heading); only
	// a native element is judged by what it was made into.
	if (!/^[a-z][a-z0-9]*$/.test(tag)) return false;
	const role = staticAttribute(node, 'role');
	if (role && INTERACTIVE_ROLES.has(role)) return true;
	if (has(node, 'tabindex')) return true;
	return (
		node.props?.some(
			(prop) => prop.type === DIRECTIVE && prop.name === 'on' && prop.arg?.content === 'click'
		) ?? false
	);
}

/** Whether the comment right before `index` (blank text aside) keeps a metadata title. */
function optedOut(siblings: TemplateNode[], index: number): boolean {
	for (let at = index - 1; at >= 0; at -= 1) {
		const sibling = siblings[at]!;
		if (sibling.type === TEXT && String(sibling.content).trim() === '') continue;
		return sibling.type === COMMENT && OPT_OUT.test(String(sibling.content));
	}
	return false;
}

function visit(node: TemplateNode, found: string[]): void {
	const children = node.children ?? [];
	for (const [index, child] of children.entries()) {
		if (child.type === ELEMENT && isInteractive(child) && !optedOut(children, index)) {
			const title = titleOf(child);
			if (title) found.push(`${child.tag}\t${title.loc.source.replace(/\s+/g, ' ')}`);
		}
		visit(child, found);
	}
	for (const branch of node.branches ?? []) visit(branch, found);
}

/** `tag<TAB>attribute` for each native title tooltip in one SFC's template. */
export function nativeTitleSites(source: string): string[] {
	const { descriptor, errors } = parse(source, {
		sourceMap: false,
		templateParseOptions: { comments: true },
	});
	if (errors.length > 0) throw new Error(String(errors[0]));
	const ast = descriptor.template?.ast as TemplateNode | undefined;
	const found: string[] = [];
	if (ast) visit(ast, found);
	return found;
}

function vueFiles(directory: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIPPED_DIRECTORIES.has(entry)) continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) vueFiles(path, out);
		else if (entry.endsWith('.vue')) out.push(path);
	}
	return out;
}

/** Every finding under `root`, as `path<TAB>tag<TAB>attribute`, sorted. */
export function nativeTitleFindings(root: string = workspace): string[] {
	const lines: string[] = [];
	for (const directory of NATIVE_TITLE_ROOTS) {
		for (const file of vueFiles(join(root, directory))) {
			const path = relative(root, file);
			let sites: string[];
			try {
				sites = nativeTitleSites(readFileSync(file, 'utf8'));
			} catch (error) {
				// A template the gate cannot read is not one it can vouch for.
				throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
					cause: error,
				});
			}
			for (const site of sites) lines.push(`${path}\t${site}`);
		}
	}
	return lines.sort();
}

if (import.meta.main) {
	const lines = nativeTitleFindings(process.argv[2] ?? workspace);
	if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}
