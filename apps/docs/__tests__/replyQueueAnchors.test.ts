import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@nuxtjs/mdc/runtime';

/**
 * Links into the Reply Queue guide land on a real heading.
 *
 * The heading ids come from the same markdown parser the site builds with
 * (Nuxt Content runs @nuxtjs/mdc). It drops `&` and collapses repeated
 * hyphens, so "Draft-on-arrival — review & send" is
 * `#draft-on-arrival-review-send`, not `-review-and-send`, and a German page
 * gets the German heading's id. Five English and two German pages linked to an
 * id the page never had.
 */

const CONTENT_ROOT = resolve(import.meta.dirname, '../content');
const PAGE = '1.guide/44.reply-queue.md';
const LINK = /\]\(\/guide\/reply-queue#([^)\s]+)\)/g;

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
	});
}

type Node = { props?: { id?: string }; children?: Node[] };
function headingIds(node: Node, ids = new Set<string>()): Set<string> {
	if (node.props?.id) ids.add(node.props.id);
	for (const child of node.children ?? []) headingIds(child, ids);
	return ids;
}

describe.each(['en', 'de'])('links to the Reply Queue guide (%s)', (locale) => {
	it('point at a heading the page has', async () => {
		const root = resolve(CONTENT_ROOT, locale);
		const parsed = await parseMarkdown(readFileSync(resolve(root, PAGE), 'utf8'));
		const ids = headingIds(parsed.body as Node);

		const links = markdownFiles(root).flatMap((file) =>
			[...readFileSync(file, 'utf8').matchAll(LINK)].map((match) => ({
				file: file.slice(root.length + 1),
				anchor: decodeURIComponent(match[1]!),
			}))
		);
		expect(links.length).toBeGreaterThan(0);
		expect(links.filter((link) => !ids.has(link.anchor))).toEqual([]);
	});
});
