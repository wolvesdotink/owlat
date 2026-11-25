import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRepositoryFiles } from '../boundedRepository';
import {
	MAX_SOURCE_BYTES,
	MAX_TOTAL_SOURCE_BYTES,
	selectBoundarySourceFiles,
} from '../packageBoundaries';
import { findConfigFiles, readRepositoryModuleAliases } from '../repositoryAliases';

// The boundary scan runs over the operator's own checkout once a plugin is configured. These
// cases point it at this repository instead of a fixture, so a config file or a source tree that
// the scan cannot handle fails here rather than in `plugins:codegen`.
const workspaceRoot = resolve(__dirname, '../../../..');

describe('plugin boundary scan over this checkout', () => {
	it('reads the aliases of every config file it visits', async () => {
		const repositoryFiles = await listRepositoryFiles(workspaceRoot);
		const visited = findConfigFiles(workspaceRoot, repositoryFiles).map((path) =>
			relative(workspaceRoot, path).replaceAll('\\', '/')
		);
		expect(visited).toEqual(
			expect.arrayContaining(['apps/marketing/vitest.config.ts', 'apps/web/vitest.config.ts'])
		);

		const aliases = await readRepositoryModuleAliases(workspaceRoot, repositoryFiles);
		expect(aliases).toContainEqual({
			matchKind: 'wildcard',
			specifierPattern: '@owlat/shared/*',
			targetPattern: resolve(workspaceRoot, 'packages/shared/src/*'),
		});
	});

	it('keeps every source file it reads inside the per-file and total byte limits', async () => {
		const repositoryFiles = await listRepositoryFiles(workspaceRoot);
		const sources = selectBoundarySourceFiles(workspaceRoot, repositoryFiles);
		const sizes = await Promise.all(sources.map(async (path) => (await stat(path)).size));
		const oversized = sources.filter((_, index) => sizes[index]! > MAX_SOURCE_BYTES);

		expect(oversized).toEqual([]);
		expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(
			MAX_TOTAL_SOURCE_BYTES
		);
	});
});
