/**
 * What `llms.txt` points an integrator or an agent at: a note on the two
 * documents every instance serves, then sections of links to the API pages,
 * the guides that matter for email content, and the machine-readable
 * documents. `nuxt-ai-ready` (part of `@nuxtjs/seo`) writes the file at
 * `nuxt generate` time with these sections before its own page index, so
 * this module only chooses and orders the links.
 *
 * Built from the English pages' front matter, so a page that is added,
 * renamed or retitled shows up without anyone editing this list. It links
 * the English pages only: the German pages mirror them under `/de/`, and an
 * agent needs one copy of each.
 *
 * No imports beyond Node: the docs image builds the site with only the
 * packages its Dockerfile copies.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DOCS_ORIGIN = 'https://docs.owlat.app';

interface Page {
	/** Path under the English content root, e.g. `2.api/17.blocks.md`. */
	file: string;
	url: string;
	title: string;
	description: string;
}

interface LlmsTxtLink {
	title: string;
	description?: string;
	href: string;
}

/** The part of `nuxt-ai-ready`'s `llmsTxt` option this site sets. */
export interface LlmsTxtSections {
	notes: string[];
	sections: Array<{ title: string; links: LlmsTxtLink[] }>;
}

/** Guide pages that matter to an integrator or agent: API keys, email content, MCP. */
const GUIDES = [
	'1.guide/17.transactional.md',
	'1.guide/20.transactional-setup.md',
	'1.guide/4.email-templates.md',
	'1.guide/5.saved-blocks.md',
	'1.guide/8.translations.md',
	'1.guide/7.email-theme.md',
	'1.guide/22.api-keys-webhooks.md',
	'1.guide/56.ai-clients.md',
] as const;

/** `1.guide/2.quick-start.md` → `/guide/quick-start`, `2.api/1.index.md` → `/api`. */
export function pageUrl(file: string): string {
	const segments = file
		.replace(/\.md$/, '')
		.split('/')
		.map((segment) => segment.replace(/^\d+\./, ''));
	if (segments.at(-1) === 'index') segments.pop();
	return `/${segments.join('/')}`;
}

/** The value of a top-level `key: value` line of the front matter, unquoted. */
function frontMatterValue(source: string, key: string): string {
	const block = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
	const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';
	if (line.startsWith("'") && line.endsWith("'")) return line.slice(1, -1).replace(/''/g, "'");
	if (line.startsWith('"') && line.endsWith('"')) {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === 'string' ? parsed : line;
	}
	return line;
}

/** Numeric file prefixes order the pages, as they order the sidebar. */
const order = (file: string) =>
	file
		.split('/')
		.map((segment) => Number(/^(\d+)\./.exec(segment)?.[1] ?? Number.MAX_SAFE_INTEGER));

function compareFiles(a: string, b: string): number {
	const left = order(a);
	const right = order(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? -1) - (right[i] ?? -1);
		if (difference !== 0) return difference;
	}
	return a.localeCompare(b);
}

export function readPages(englishRoot: string): Page[] {
	const walk = (directory: string): string[] =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return walk(path);
			// Content paths use `/` on every platform; `relative` uses the OS separator.
			return entry.name.endsWith('.md') ? [relative(englishRoot, path).split(sep).join('/')] : [];
		});
	return walk(englishRoot)
		.sort(compareFiles)
		.map((file) => {
			const source = readFileSync(join(englishRoot, file), 'utf8');
			return {
				file,
				url: pageUrl(file),
				title: frontMatterValue(source, 'title'),
				description: frontMatterValue(source, 'description'),
			};
		});
}

const link = (page: Page): LlmsTxtLink => ({
	title: page.title,
	href: `${DOCS_ORIGIN}${page.url}`,
	...(page.description && { description: page.description }),
});

export function llmsTxtSections(englishRoot: string): LlmsTxtSections {
	const pages = readPages(englishRoot);
	const byFile = new Map(pages.map((page) => [page.file, page]));
	const guide = (file: string) => {
		const page = byFile.get(file);
		if (!page) throw new Error(`llms.txt links ${file}, which the docs do not have`);
		return page;
	};
	return {
		notes: [
			'Every Owlat install serves its own API under its API base URL. Two documents describe it without an API key: `GET <API base URL>/api/v1/openapi.json`, the OpenAPI 3.1 document of the public API with that instance as its server, and `GET <API base URL>/api/v1/schemas/blocks.json`, the JSON Schema of the block content that templates, transactional emails and saved blocks store. Read the block content reference before writing block JSON.',
		],
		sections: [
			{
				title: 'API',
				links: pages.filter((page) => page.file.startsWith('2.api/')).map(link),
			},
			{ title: 'Guides', links: GUIDES.map((file) => link(guide(file))) },
			{
				title: 'Machine-readable',
				links: [
					{
						title: 'Block content schema',
						href: `${DOCS_ORIGIN}/schemas/blocks.json`,
						description:
							'JSON Schema 2020-12 of block content for the current release, one definition per block type with a worked example. An instance serves its own at /api/v1/schemas/blocks.json.',
					},
					{
						title: 'OpenAPI document',
						href: 'https://github.com/wolvesdotink/owlat/blob/main/packages/public-contract/openapi.json',
						description:
							'The public API with a placeholder server. An instance serves its own at /api/v1/openapi.json.',
					},
				],
			},
		],
	};
}
