import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const guard = resolve(import.meta.dirname, '..', '..', 'scripts', 'check-codegen.sh');

function fixture(generated: string): { source: string; declaration: string } {
	const directory = mkdtempSync(join(tmpdir(), 'owlat-codegen-guard-'));
	temporaryDirectories.push(directory);
	const source = join(directory, 'convex');
	const declaration = join(directory, 'api.d.ts');
	mkdirSync(join(source, 'delivery'), { recursive: true });
	writeFileSync(join(source, 'delivery', 'example.ts'), 'export const value = 1;\n');
	writeFileSync(declaration, generated);
	return { source, declaration };
}

function runGuard(source: string, declaration: string): string {
	return execFileSync('bash', [guard], {
		encoding: 'utf8',
		env: {
			...process.env,
			CODEGEN_SOURCE_DIR: source,
			CODEGEN_DECLARATION_FILE: declaration,
		},
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('Convex codegen guard', () => {
	it.each(["'", '"'])(
		'accepts %s-quoted generated declarations when import and mapping both exist',
		(quote) => {
			const { source, declaration } = fixture(
				[
					`import type * as delivery_example from ${quote}../delivery/example.js${quote};`,
					'declare const fullApi: ApiFromModules<{',
					`\t${quote}delivery/example${quote}: typeof delivery_example;`,
					'}>;',
				].join('\n')
			);
			expect(runGuard(source, declaration)).toContain('imports and maps every Convex module');
		}
	);

	it('rejects an imported module omitted from fullApi', () => {
		const { source, declaration } = fixture(
			"import type * as delivery_example from '../delivery/example.js';\n"
		);
		expect(() => runGuard(source, declaration)).toThrow(
			expect.objectContaining({
				stdout: expect.stringContaining('missing fullApi mapping'),
			})
		);
	});
});
