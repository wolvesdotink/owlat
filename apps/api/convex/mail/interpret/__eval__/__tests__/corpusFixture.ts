/** The checked-in corpus, parsed once per test file. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvalCorpus, type EvalThread } from '../corpus';

const CORPUS_DIR = join(import.meta.dirname, '..', 'corpus');

export function loadCorpus(): EvalThread[] {
	return parseEvalCorpus(
		readdirSync(CORPUS_DIR)
			.filter((f) => f.endsWith('.json'))
			.sort()
			.map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as unknown)
	);
}
