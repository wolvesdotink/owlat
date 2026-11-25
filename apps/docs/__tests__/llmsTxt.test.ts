import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_ORIGIN, buildLlmsTxt, pageUrl, readPages } from '../scripts/llmsTxt';

const ENGLISH_ROOT = fileURLToPath(new URL('../content/en', import.meta.url));
const text = buildLlmsTxt(ENGLISH_ROOT);

describe('llms.txt', () => {
	it('has the llmstxt.org shape: a title, a summary quote, then link sections', () => {
		const lines = text.split('\n');
		expect(lines[0]).toBe('# Owlat');
		expect(lines[2]).toMatch(/^> /);
		const sections = lines.filter((line) => line.startsWith('## '));
		expect(sections).toEqual(['## API', '## Guides', '## Machine-readable', '## Optional']);
		for (const line of lines.filter((l) => l.startsWith('- '))) {
			expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/);
		}
	});

	it('links every API page, the block reference among them, with its description', () => {
		const api = readPages(ENGLISH_ROOT).filter((page) => page.file.startsWith('2.api/'));
		expect(api.length).toBeGreaterThan(10);
		for (const page of api) {
			expect(text).toContain(`- [${page.title}](${DOCS_ORIGIN}${page.url})`);
		}
		expect(text).toContain(`(${DOCS_ORIGIN}/api/blocks): `);
	});

	it('names both documents an instance serves, and the published block schema', () => {
		expect(text).toContain('/api/v1/openapi.json');
		expect(text).toContain('/api/v1/schemas/blocks.json');
		expect(text).toContain(`(${DOCS_ORIGIN}/schemas/blocks.json)`);
	});

	it('links the English pages only', () => {
		expect(text).not.toContain(`${DOCS_ORIGIN}/de/`);
	});

	it('builds page URLs the way the content collections route them', () => {
		expect(pageUrl('1.guide/2.quick-start.md')).toBe('/guide/quick-start');
		expect(pageUrl('2.api/1.index.md')).toBe('/api');
		expect(pageUrl('2.api/17.blocks.md')).toBe('/api/blocks');
	});
});
