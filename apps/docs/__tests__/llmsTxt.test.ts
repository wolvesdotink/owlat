import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_ORIGIN, llmsTxtSections, pageUrl, readPages } from '../scripts/llmsTxt';

const ENGLISH_ROOT = fileURLToPath(new URL('../content/en', import.meta.url));
const config = llmsTxtSections(ENGLISH_ROOT);
const links = config.sections.flatMap((section) => section.links);

describe('the llms.txt sections', () => {
	it('lead with the API, the guides and the machine-readable documents', () => {
		expect(config.sections.map((section) => section.title)).toEqual([
			'API',
			'Guides',
			'Machine-readable',
		]);
		for (const section of config.sections) expect(section.links.length).toBeGreaterThan(0);
	});

	it('link every API page, the block reference among them, with its description', () => {
		const api = readPages(ENGLISH_ROOT).filter((page) => page.file.startsWith('2.api/'));
		expect(api.length).toBeGreaterThan(10);
		expect(config.sections[0]!.links.map((link) => link.href)).toEqual(
			api.map((page) => `${DOCS_ORIGIN}${page.url}`)
		);
		const blocks = links.find((link) => link.href === `${DOCS_ORIGIN}/api/blocks`);
		expect(blocks?.description).toBeTruthy();
	});

	it('name both documents an instance serves, and the published block schema', () => {
		const notes = config.notes.join('\n');
		expect(notes).toContain('/api/v1/openapi.json');
		expect(notes).toContain('/api/v1/schemas/blocks.json');
		expect(links.map((link) => link.href)).toContain(`${DOCS_ORIGIN}/schemas/blocks.json`);
	});

	it('link the English pages only', () => {
		for (const link of links) expect(link.href).not.toContain(`${DOCS_ORIGIN}/de/`);
	});

	it('build page URLs the way the content collections route them', () => {
		expect(pageUrl('1.guide/2.quick-start.md')).toBe('/guide/quick-start');
		expect(pageUrl('2.api/1.index.md')).toBe('/api');
		expect(pageUrl('2.api/17.blocks.md')).toBe('/api/blocks');
	});
});
