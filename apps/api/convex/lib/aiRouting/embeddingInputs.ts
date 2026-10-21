/**
 * The text each corpus row is embedded from. One definition shared
 * by the writers (`knowledge/extraction.ts`, `semanticFileProcessing.ts`), the
 * re-embed job, the staged rebuild and the sample check, so a re-embedded
 * vector is made from the same input the original writer used.
 */

/** A knowledge entry: `title: content`, as extraction embeds it. */
export function knowledgeEmbeddingInput(row: { title: string; content: string }): string {
	return `${row.title}: ${row.content}`;
}

/** Files embed their title, summary and the head of the extracted text. */
const FILE_TEXT_HEAD_CHARS = 2000;
/** Shorter inputs carry too little to embed (processing has always skipped them). */
const FILE_MIN_INPUT_CHARS = 10;

/** A file's embedding input, or null when it has too little text to embed. */
export function fileEmbeddingInput(row: {
	title?: string;
	summary?: string;
	extractedText?: string;
}): string | null {
	const text = [row.title, row.summary, row.extractedText?.slice(0, FILE_TEXT_HEAD_CHARS)]
		.filter(Boolean)
		.join(' ');
	return text.length > FILE_MIN_INPUT_CHARS ? text : null;
}

/**
 * A short fingerprint of an input (FNV-1a, 32 bit, plus the length). The
 * re-embed job reads a row, embeds outside the transaction and commits; the
 * commit compares fingerprints so a row edited in between keeps its new text
 * out of an old vector. Not a security hash.
 */
export function inputFingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${text.length}:${hash.toString(16)}`;
}

/** The two embedding-bearing tables. */
export type CorpusTable = 'knowledgeEntries' | 'semanticFiles';

/** The fields of a corpus row its embedding input and eligibility are read from. */
export interface CorpusRowFields {
	title?: string;
	content?: string;
	summary?: string;
	extractedText?: string;
	expiresAt?: number;
}

/** A row's embedding input as written, whether or not the row is eligible now. */
export function embeddingInputText(table: CorpusTable, row: CorpusRowFields): string | null {
	if (table === 'knowledgeEntries') {
		return knowledgeEmbeddingInput({ title: row.title ?? '', content: row.content ?? '' });
	}
	return fileEmbeddingInput(row);
}

/**
 * The input a row is embedded from when it is eligible for vector search, or
 * null: an expired knowledge entry, a file its pipeline has not processed yet
 * (that pipeline embeds it), or a file with too little text.
 */
export function corpusRowInput(
	table: CorpusTable,
	row: CorpusRowFields,
	now: number
): string | null {
	if (table === 'knowledgeEntries') {
		if (row.expiresAt !== undefined && row.expiresAt <= now) return null;
		return embeddingInputText(table, row);
	}
	if (row.extractedText === undefined) return null;
	return embeddingInputText(table, row);
}
