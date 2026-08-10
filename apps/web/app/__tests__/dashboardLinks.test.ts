import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = join(import.meta.dirname, '..');
const pagesRoot = join(appRoot, 'pages');

async function filesUnder(directory: string, extension: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory()
				? filesUnder(path, extension)
				: entry.name.endsWith(extension)
					? [path]
					: [];
		})
	);
	return nested.flat();
}

function routePattern(file: string): RegExp {
	let path = `/${relative(pagesRoot, file)
		.replace(/\\/g, '/')
		.replace(/\.vue$/, '')}`;
	path = path.replace(/\/index$/, '') || '/';
	const pattern = path
		.split('/')
		.map((part) => {
			if (/^\[\.\.\..+\]$/.test(part)) return '.+';
			if (/^\[\[.+\]\]$/.test(part)) return '[^/]*';
			if (/^\[.+\]$/.test(part)) return '[^/]+';
			return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('/');
	return new RegExp(`^${pattern}/?$`);
}

describe('authenticated dashboard links', () => {
	it('every statically declared internal link resolves to a Nuxt page', async () => {
		const routePatterns = (await filesUnder(pagesRoot, '.vue')).map(routePattern);
		const broken: string[] = [];
		for (const file of await filesUnder(appRoot, '.vue')) {
			const source = await readFile(file, 'utf8');
			for (const match of source.matchAll(/(?:to|href)="(\/dashboard[^"#{?`]*)/g)) {
				const route = match[1]!;
				if (!routePatterns.some((pattern) => pattern.test(route))) {
					broken.push(`${relative(appRoot, file)} → ${route}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});
});
