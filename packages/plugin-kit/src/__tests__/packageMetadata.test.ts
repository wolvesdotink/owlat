import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
	readonly version: string;
	readonly files?: readonly string[];
	readonly main?: string;
	readonly module?: string;
	readonly types?: string;
}

function readPackage(path: URL): PackageMetadata {
	return JSON.parse(readFileSync(path, 'utf8')) as PackageMetadata;
}

describe('published package metadata', () => {
	it('stays on the unified pre-1.0 release version', () => {
		const rootPackage = readPackage(new URL('../../../../package.json', import.meta.url));
		const pluginKitPackage = readPackage(new URL('../../package.json', import.meta.url));

		expect(pluginKitPackage.version).toBe(rootPackage.version);
	});

	it('publishes built JavaScript and declarations instead of TypeScript source', () => {
		const pluginKitPackage = readPackage(new URL('../../package.json', import.meta.url));

		expect(pluginKitPackage).toMatchObject({
			files: ['dist', 'README.md'],
			main: './dist/index.js',
			module: './dist/index.js',
			types: './dist/index.d.ts',
		});
	});
});
