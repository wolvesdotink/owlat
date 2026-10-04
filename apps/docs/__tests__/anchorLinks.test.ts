import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMarkdown } from '@nuxtjs/mdc/runtime';

/**
 * Every in-site link with a `#fragment` lands on a heading its target page has.
 *
 * The heading ids come from the same markdown parser the site builds with
 * (Nuxt Content runs @nuxtjs/mdc). Its slugs are not the ones a reader guesses:
 * `&` is dropped and repeated hyphens collapse, so "Offline & local cache" is
 * `#offline-local-cache`, never `#offline--local-cache`. A German page gets the
 * German heading's id, so a link copied from the English source with its
 * English fragment loads the right page and stays at the top. That is how about
 * a hundred links drifted before this check covered the whole site.
 *
 * Links are read from the parsed tree, not the raw markdown, so a link shown
 * inside a code block is not a link, and a component's `to`/`href` prop (a
 * `::link-card{to="…"}`) is checked the same way as an inline `[text](…)`.
 * Each locale is checked against its own pages: `ProseA` keeps a reader in the
 * locale they are in, so `/guide/postbox#…` on a German page opens the German
 * Postbox page.
 */

const CONTENT_ROOT = resolve(import.meta.dirname, '../content');
const LOCALES = ['en', 'de'] as const;

type Node = { tag?: string; props?: Record<string, unknown>; children?: Node[] };

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
	});
}

/**
 * The route Nuxt Content publishes for a file: numeric ordering prefixes are
 * stripped from every segment and `index` is its folder's route, so
 * `1.guide/0.index.md` is `/guide` and `1.guide/27.postbox.md` is
 * `/guide/postbox`.
 */
function routeOf(file: string): string {
	const segments = file
		.replace(/\.md$/, '')
		.split('/')
		.map((segment) => segment.replace(/^\d+\./, ''));
	if (segments.at(-1) === 'index') segments.pop();
	return `/${segments.join('/')}`;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

type Page = { file: string; route: string; ids: Set<string>; targets: string[] };

async function readPage(root: string, path: string): Promise<Page> {
	const file = relative(root, path);
	const parsed = await parseMarkdown(readFileSync(path, 'utf8'));
	const ids = new Set<string>();
	const targets: string[] = [];
	walk(parsed.body as Node, (node) => {
		const { id, href, to } = node.props ?? {};
		if (typeof id === 'string') ids.add(id);
		for (const target of [href, to]) {
			if (typeof target === 'string' && /^[/#]/.test(target) && !target.startsWith('//')) {
				targets.push(target);
			}
		}
	});
	return { file, route: routeOf(file), ids, targets };
}

describe('routeOf', () => {
	it('strips ordering prefixes and maps index to its folder', () => {
		expect(routeOf('1.guide/27.postbox.md')).toBe('/guide/postbox');
		expect(routeOf('1.guide/0.index.md')).toBe('/guide');
		expect(routeOf('3.developer/decisions/13.050-draft-strategy-registry.md')).toBe(
			'/developer/decisions/050-draft-strategy-registry'
		);
	});
});

describe.each(LOCALES)('anchor links (%s)', (locale) => {
	const root = resolve(CONTENT_ROOT, locale);
	let pages: Page[] = [];
	let idsByRoute = new Map<string, Set<string>>();

	beforeAll(async () => {
		pages = await Promise.all(markdownFiles(root).map((path) => readPage(root, path)));
		idsByRoute = new Map(pages.map((page) => [page.route, page.ids]));
	});

	it('finds the pages and their links', () => {
		expect(pages.length).toBeGreaterThan(100);
		// A parser change that stopped surfacing links would otherwise pass the
		// check below with nothing to check.
		const fragments = pages.flatMap((page) => page.targets.filter((t) => t.includes('#')));
		expect(fragments.length).toBeGreaterThan(100);
	});

	it('point at a heading the target page has', () => {
		const broken = pages.flatMap((page) =>
			page.targets
				.filter((target) => target.includes('#'))
				.flatMap((target) => {
					const [path = '', fragment = ''] = target.split('#', 2);
					const route = path === '' ? page.route : path.replace(/\/$/, '') || '/';
					const ids = idsByRoute.get(route);
					const anchor = decodeURIComponent(fragment);
					if (ids?.has(anchor)) return [];
					return [`${page.file} -> ${target}${ids ? '' : ' (no such page)'}`];
				})
		);
		expect(broken).toEqual([]);
	});
});
