import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertGeneratedPathSafety } from '../atomicWrite';
import { PluginCodegenError } from '../errors';
import { generatePluginComposition } from '../generate';
import {
	generatedArtifacts,
	GENERATED_ARTIFACT_PATHS,
	renderPluginComposition,
	type GeneratedPluginComposition,
} from '../render';

/**
 * The codegen output set is ONE table.
 *
 * It used to be written three times — the fields of
 * `GeneratedPluginComposition`, twenty-two `*_OUTPUT_PATH` constants, and
 * twenty-two `{ path, source }` target entries — so adding a registry took six
 * coordinated edits and forgetting one silently dropped a file from both the
 * writer and the `--check` staleness gate, with nothing red.
 *
 * These cases pin the collapse: every artifact key has exactly one path, an
 * artifact added to the table is written, path-safety-checked and
 * staleness-checked with no other edit, and `--check` sees every one of them.
 */
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

/** A workspace with an empty plugin config: codegen emits every artifact empty. */
async function emptyWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-artifacts-'));
	temporaryRoots.push(root);
	await writeFile(
		join(root, 'plugins.config.ts'),
		'export default { bundledPluginPackages: [] };\n'
	);
	return root;
}

describe('generated artifact table', () => {
	const composition = renderPluginComposition([]);

	it('gives every composition field exactly one output path', () => {
		const keys = Object.keys(composition) as (keyof GeneratedPluginComposition)[];
		expect(keys.length).toBeGreaterThan(20);
		expect(Object.keys(GENERATED_ARTIFACT_PATHS).sort()).toEqual([...keys].sort());
		const paths = Object.values(GENERATED_ARTIFACT_PATHS);
		expect(new Set(paths).size, 'two artifacts share an output path').toBe(paths.length);
		for (const path of paths) expect(path).toMatch(/\.generated\.ts$/);
	});

	it('derives the writer targets from the table, in table order', () => {
		const artifacts = generatedArtifacts(composition);
		expect(artifacts.map((artifact) => artifact.key)).toEqual(
			Object.keys(GENERATED_ARTIFACT_PATHS)
		);
		for (const artifact of artifacts) {
			expect(artifact.outputPath).toBe(GENERATED_ARTIFACT_PATHS[artifact.key]);
			expect(artifact.source).toBe(composition[artifact.key]);
		}
	});

	it('keeps every artifact path safe to write', async () => {
		const root = await emptyWorkspace();
		for (const artifact of generatedArtifacts(composition)) {
			await expect(
				assertGeneratedPathSafety(root, join(root, artifact.outputPath))
			).resolves.toBeUndefined();
			expect(relative(root, join(root, artifact.outputPath)).startsWith('..')).toBe(false);
		}
	});

	it('writes every artifact in the table and checks every one for staleness', async () => {
		const root = await emptyWorkspace();
		await generatePluginComposition(root);

		const artifacts = generatedArtifacts(composition);
		for (const artifact of artifacts) {
			expect(await readFile(join(root, artifact.outputPath), 'utf8')).toBe(artifact.source);
		}

		// Every single artifact is covered by --check: tampering with any one of
		// them must be reported, naming that file.
		for (const artifact of artifacts) {
			await writeFile(join(root, artifact.outputPath), '// tampered\n');
			const error = await generatePluginComposition(root, { check: true }).then(
				() => undefined,
				(cause: unknown) => cause
			);
			expect(error, `${artifact.outputPath} is not covered by --check`).toBeInstanceOf(
				PluginCodegenError
			);
			expect((error as PluginCodegenError).code).toBe('generated_files_stale');
			expect((error as PluginCodegenError).details).toEqual([artifact.outputPath]);
			await writeFile(join(root, artifact.outputPath), artifact.source);
		}
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
		// One --check run per artifact: deliberate, and slower than the 5s default
		// once the root ci:test gate runs every package in parallel.
	});
});
