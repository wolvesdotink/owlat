/**
 * The text each corpus row is embedded from (ADR-0073). One definition shared
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
