import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMarkdown } from '@nuxtjs/mdc/runtime';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../vitest.timeouts';

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

type Source = { file: string; route: string; markdown: string };
type Parsed = { ids: Set<string>; targets: string[] };

function readSources(root: string): Source[] {
	return markdownFiles(root).map((path) => {
		const file = relative(root, path);
		return { file, route: routeOf(file), markdown: readFileSync(path, 'utf8') };
	});
}

/**
 * One page through the site's parser: every element id, and every in-site
 * `href`/`to` with a fragment.
 *
 * `parseMarkdown` builds a fresh processor per call, and that is required: a
 * reused `createMarkdownParser` keeps one heading slugger across files, so the
 * second page's "Next steps" comes out as `#next-steps-1`.
 */
async function parse(markdown: string): Promise<Parsed> {
	const parsed = await parseMarkdown(markdown);
	const ids = new Set<string>();
	const targets: string[] = [];
	walk(parsed.body as Node, (node) => {
		const { id, href, to } = node.props ?? {};
		if (typeof id === 'string') ids.add(id);
		for (const target of [href, to]) {
			if (typeof target === 'string' && /^[/#]/.test(target) && target.includes('#')) {
				if (!target.startsWith('//')) targets.push(target);
			}
		}
	});
	return { ids, targets };
}

/**
 * Whether a page can hold a fragment link at all. Every way of writing one
 * (`[x](/a#b)`, a `[r]: /a#b` definition, `href="…#b"`, `{to="…#b"}`) puts a
 * literal `#` in the source, so once the heading markers are removed, a page
 * with no `#` left has none. It is a cheap superset, not a parser: code
 * comments and the like still count, and the parse decides.
 */
function mayHoldFragmentLink(markdown: string): boolean {
	return markdown.replace(/^#{1,6}\s/gm, '').includes('#');
}

/** The route and decoded heading id a link on `fromRoute` points at. */
function resolveTarget(fromRoute: string, target: string): { route: string; anchor: string } {
	const [path = '', fragment = ''] = target.split('#', 2);
	const route = path === '' ? fromRoute : path.replace(/\/$/, '') || '/';
	return { route, anchor: decodeURIComponent(fragment) };
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
	let sources: Source[] = [];
	let links: { file: string; route: string; target: string }[] = [];
	const parsedByRoute = new Map<string, Parsed>();

	// Parsing is the whole cost of this suite, and it is CPU-bound, so running
	// pages concurrently would not help. Parsing every page took about 4 s per
	// locale on a dev machine and about 10 s under the V8 coverage CI collects,
	// and CI's shared runner hit the 10 s hook limit. So only the pages that
	// matter are parsed: the ones that can hold a fragment link (about half),
	// then the pages those links point at. That brings it to about 3 s, or 8 s
	// with coverage. The hook also gets the shared parallel-gate budget
	// (vitest.timeouts.ts), because the cost is fixed and grows with the docs.
	beforeAll(async () => {
		sources = readSources(resolve(CONTENT_ROOT, locale));
		const parseAll = async (pages: Source[]) => {
			for (const page of pages) parsedByRoute.set(page.route, await parse(page.markdown));
		};

		const linking = sources.filter((page) => mayHoldFragmentLink(page.markdown));
		await parseAll(linking);
		links = linking.flatMap((page) =>
			parsedByRoute
				.get(page.route)!
				.targets.map((target) => ({ file: page.file, route: page.route, target }))
		);

		const wanted = new Set(links.map((link) => resolveTarget(link.route, link.target).route));
		await parseAll(
			sources.filter((page) => wanted.has(page.route) && !parsedByRoute.has(page.route))
		);
	}, PARALLEL_GATE_TIMEOUT_MS);

	it('finds the pages and their links', () => {
		expect(sources.length).toBeGreaterThan(100);
		// A parser change that stopped surfacing links would otherwise pass the
		// check below with nothing to check.
		expect(links.length).toBeGreaterThan(100);
	});

	it('point at a heading the target page has', () => {
		const broken = links.flatMap(({ file, route: fromRoute, target }) => {
			const { route, anchor } = resolveTarget(fromRoute, target);
			const ids = parsedByRoute.get(route)?.ids;
			if (ids?.has(anchor)) return [];
			return [`${file} -> ${target}${ids ? '' : ' (no such page)'}`];
		});
		expect(broken).toEqual([]);
	});
});
