import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
	readonly version: string;
	readonly license?: string;
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
			license: 'Apache-2.0',
			files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
			main: './dist/index.js',
			module: './dist/index.js',
			types: './dist/index.d.ts',
		});
	});

	it('uses the repository Apache license and Owlat notice as package legal files', () => {
		const license = readFileSync(new URL('../../../../LICENSE', import.meta.url), 'utf8');
		const notice = readFileSync(new URL('../../../../NOTICE', import.meta.url), 'utf8');

		expect(license).toContain('Apache License');
		expect(license).toContain('Version 2.0, January 2004');
		expect(notice).toBe(
			'Owlat\nCopyright 2026 Wolves\n\nLicensed under the Apache License, Version 2.0.\n'
		);
	});
});
