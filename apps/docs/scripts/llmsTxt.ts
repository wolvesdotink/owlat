/**
 * `llms.txt` for the docs site, in the llmstxt.org shape: a title, a one-line
 * summary, a paragraph, then sections of links with a one-line description
 * each. Built from the English pages' front matter at `nuxt generate` time
 * (see the `nitro:build:public-assets` hook in `nuxt.config.ts`), so a page
 * that is added, renamed or retitled shows up without anyone editing the file.
 *
 * It links the English pages only. The German pages mirror them under `/de/`,
 * and an agent reading the file needs one copy of each.
 *
 * No imports beyond Node: the docs image builds the site with only the
 * packages its Dockerfile copies.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const DOCS_ORIGIN = 'https://docs.owlat.app';

interface Page {
	/** Path under the English content root, e.g. `2.api/17.blocks.md`. */
	file: string;
	url: string;
	title: string;
	description: string;
}

/** Guide pages that matter to an integrator or agent: API keys, email content, MCP. */
const CONTENT_GUIDES = [
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
			return entry.name.endsWith('.md') ? [relative(englishRoot, path)] : [];
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

const link = (page: Page) =>
	`- [${page.title}](${DOCS_ORIGIN}${page.url})${page.description ? `: ${page.description}` : ''}`;

export function buildLlmsTxt(englishRoot: string): string {
	const pages = readPages(englishRoot);
	const byFile = new Map(pages.map((page) => [page.file, page]));
	const guide = (file: string) => {
		const page = byFile.get(file);
		if (!page) throw new Error(`llms.txt links ${file}, which the docs do not have`);
		return page;
	};
	const api = pages.filter((page) => page.file.startsWith('2.api/'));
	const curated = new Set<string>([...CONTENT_GUIDES, ...api.map((page) => page.file)]);
	const rest = pages.filter(
		(page) =>
			!curated.has(page.file) &&
			(page.file.startsWith('1.guide/') || page.file.startsWith('3.developer/'))
	);

	return [
		'# Owlat',
		'',
		'> Owlat is a modular, self-hosted email platform: marketing campaigns, transactional email, a personal mailbox and a team inbox, with a REST API and SDKs for JavaScript and Java.',
		'',
		'Every Owlat install serves its own API under its API base URL. Two documents describe it without an API key: `GET <API base URL>/api/v1/openapi.json`, the OpenAPI 3.1 document of the public API with that instance as its server, and `GET <API base URL>/api/v1/schemas/blocks.json`, the JSON Schema of the block content that templates, transactional emails and saved blocks store. Read the block reference before writing block JSON. The pages below are English; German versions live at the same paths under `/de/`.',
		'',
		'## API',
		'',
		...api.map(link),
		'',
		'## Guides',
		'',
		...CONTENT_GUIDES.map((file) => link(guide(file))),
		'',
		'## Machine-readable',
		'',
		`- [Block content schema](${DOCS_ORIGIN}/schemas/blocks.json): JSON Schema 2020-12 of block content for the current release, one definition per block type with a worked example. An instance serves its own at /api/v1/schemas/blocks.json.`,
		'- [OpenAPI document](https://github.com/wolvesdotink/owlat/blob/main/packages/public-contract/openapi.json): the public API with a placeholder server. An instance serves its own at /api/v1/openapi.json.',
		'',
		'## Optional',
		'',
		...rest.map(link),
		'',
	].join('\n');
}
