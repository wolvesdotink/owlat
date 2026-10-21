/**
 * Custody of the corpus fields that decide vector search: a row's
 * embedding input (title, content, summary, extracted text), its eligibility
 * (expiry, processing) and its vector stamps. Every write of them goes through
 * `patchCorpusRow` / `noteCorpusInsert` (lib/aiRouting/embeddingActivation.ts),
 * which applies the input-change rule and marks a staged rebuild. This scans
 * the backend for a direct `db.patch` / `db.replace` naming one of those fields
 * in a module that touches the corpus, and for a corpus insert not followed by
 * `noteCorpusInsert`, so a new writer cannot forget.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const FIELD =
	/\b(expiresAt|extractedText|summary|title|content|embedding|embeddingSpaceId|secondaryEmbedding|secondaryEmbeddingSpaceId|embeddingAttestationId|embeddingProvenance|embeddingGeneratedAt)\s*[:,}]/;

/** Direct writes that are not corpus rows, each with why. */
const ALLOWED_PATCHES: Record<string, string> = {
	// The job row's own root id: `embedding:${jobId}` is a template string, not a field.
	'aiRouting/embeddingReembedJobs.ts#rootRequestId': 'job row, not a corpus row',
};

/** Corpus inserts that need no note, each with why. */
const ALLOWED_INSERTS: Record<string, string> = {
	// An uploaded file is not eligible until processing writes its text, which
	// goes through patchCorpusRow (semanticFiles.updateProcessedMetadata).
	'semanticFiles.ts': 'unprocessed file',
};

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return ['__tests__', '_generated', 'schema', 'migrations'].includes(name)
				? []
				: sources(path);
		}
		return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
	});
}

describe('corpus field writers', () => {
	const files = sources(ROOT).map((path) => ({
		file: relative(ROOT, path),
		text: readFileSync(path, 'utf8'),
	}));
	const corpusFiles = files.filter(
		({ text }) => text.includes("'knowledgeEntries'") || text.includes("'semanticFiles'")
	);

	it('finds the corpus modules (the scan is not empty)', () => {
		const names = corpusFiles.map(({ file }) => file);
		expect(names).toEqual(expect.arrayContaining(['knowledge/graph.ts', 'semanticFiles.ts']));
	});

	it('writes no embedding-relevant field with a direct patch', () => {
		const offenders: string[] = [];
		for (const { file, text } of corpusFiles) {
			if (file === 'lib/aiRouting/embeddingActivation.ts') continue; // the helpers themselves
			for (const match of text.matchAll(/db\.(patch|replace)\(/g)) {
				const call = text.slice(match.index, text.indexOf(');', match.index));
				if (!FIELD.test(call)) continue;
				const key = Object.keys(ALLOWED_PATCHES).find(
					(allowed) => allowed.startsWith(`${file}#`) && call.includes(allowed.split('#')[1]!)
				);
				if (!key) offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('notes every corpus insert', () => {
		const offenders: string[] = [];
		for (const { file, text } of files) {
			const inserts = [...text.matchAll(/db\.insert\('(knowledgeEntries|semanticFiles)'/g)].length;
			const notes = [...text.matchAll(/noteCorpusInsert\(/g)].length;
			if (inserts > notes && !(file in ALLOWED_INSERTS))
				offenders.push(`${file}: ${inserts} > ${notes}`);
		}
		expect(offenders).toEqual([]);
	});
});
