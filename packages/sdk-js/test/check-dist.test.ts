import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain ESM build script without declarations
import { externalSpecifiers } from '../scripts/check-dist.mjs';

describe('check-dist', () => {
	it('flags a bare specifier in each import form', () => {
		const text = [
			"import { z } from 'zod';",
			'import type { Contact } from "@owlat/public-contract";',
			"const v = require('convex/values');",
			"const lazy = await import('left-pad');",
			"export * from 'other';",
		].join('\n');
		expect(externalSpecifiers(text)).toEqual([
			'@owlat/public-contract',
			'convex/values',
			'left-pad',
			'other',
			'zod',
		]);
	});

	it('allows relative paths and node builtins', () => {
		expect(
			externalSpecifiers("import { a } from './a';\nconst fs = require('node:fs');\n")
		).toEqual([]);
	});

	it('ignores the package name inside a doc example', () => {
		expect(
			externalSpecifiers("/**\n * import { Owlat } from '@owlat/sdk-js';\n */\n// require('x')\n")
		).toEqual([]);
	});
});
