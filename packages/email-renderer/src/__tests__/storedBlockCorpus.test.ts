import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMAIL_RENDERER_VERSION } from '../version';
import { SNAPSHOTS_DIR, loadStoredBlockCorpus, renderStoredFixture } from './storedBlocks/corpus';

// Every stored EditorBlock document in the corpus renders with the current
// renderer, and its HTML matches the snapshot for EMAIL_RENDERER_VERSION. See
// storedBlocks/corpus.ts for the rules.

const corpus = loadStoredBlockCorpus();
const snapshotDirName = `renderer-v${EMAIL_RENDERER_VERSION}`;

const REGENERATE_HINT =
	'A stored EditorBlock document renders different HTML. If the change is ' +
	'intended, bump EMAIL_RENDERER_VERSION (src/version.ts), delete the old ' +
	'snapshots/renderer-v* directory and run vitest to write the new one. ' +
	'Never rewrite a snapshot of the current version in place.';

describe('stored EditorBlock corpus', () => {
	it('has fixtures', () => {
		expect(corpus.length).toBeGreaterThan(0);
	});

	describe.each(corpus)('$name (contentBlockVersion $contentBlockVersion, $field)', (fixture) => {
		it('renders with the current renderer, matching its versioned snapshot', async () => {
			const rendered = renderStoredFixture(fixture);

			expect(rendered.html).toMatch(/^<!DOCTYPE html>/i);
			expect(rendered.html).toContain('</html>');
			expect(typeof rendered.text).toBe('string');
			await expect(rendered.html, REGENERATE_HINT).toMatchFileSnapshot(
				join(SNAPSHOTS_DIR, snapshotDirName, `${fixture.name}.html`)
			);
		});
	});

	// A missing snapshot is the per-fixture test's failure (and, outside CI, is
	// written at the end of the run); this one finds what no fixture owns.
	it('keeps snapshots for the current renderer version only, one per fixture', () => {
		const dirs = existsSync(SNAPSHOTS_DIR) ? readdirSync(SNAPSHOTS_DIR) : [];
		expect(dirs.filter((dir) => dir !== snapshotDirName)).toEqual([]);
		const dir = join(SNAPSHOTS_DIR, snapshotDirName);
		const owned = new Set(corpus.map((fixture) => `${fixture.name}.html`));
		const files = existsSync(dir) ? readdirSync(dir) : [];
		expect(files.filter((file) => !owned.has(file))).toEqual([]);
	});
});
