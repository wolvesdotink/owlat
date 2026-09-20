/**
 * WHICH FORMAT A FILE'S TEXT COMES OUT OF — the one table, for both sides of
 * the extraction seam.
 *
 * `semanticFileProcessing.extractText` answers a Word document with
 * `[Word document: contract.docx]`, a spreadsheet with `[Spreadsheet: q3.xlsx]`
 * and an image with `[Image: scan.png]`. Those files are still ingested —
 * summarised, tagged, embedded — but everything downstream is working from a
 * filename, so an inbound `.docx` that "indexed" cleanly reads to the user
 * exactly like a PDF whose contents the assistant actually has. The capture
 * path has to know which of the two happened before it writes a marker.
 *
 * This module used to be a SECOND hand-kept copy of the extractor's branch
 * list, justified by "that module is `'use node'`, so the ingest path cannot
 * import it" — which is backwards: the dependency only fails one way, and
 * `semanticFileProcessing.ts` already imports `lib/constants`,
 * `lib/fileSearchText`, `lib/rrf` and `lib/contactScope`. So the classification
 * lives HERE, once, and the `'use node'` extractor dispatches on it rather than
 * re-deriving it from the same two strings.
 */

/**
 * What `extractText` will do with a file:
 *   · `html` / `text` / `csv` — real content, read straight out of the bytes;
 *   · `pdf` — real content, via `unpdf`, WITH a placeholder fallback (see the
 *     note on {@link hasTextExtraction});
 *   · `word` / `spreadsheet` / `image` / `file` — a `[Kind: filename]`
 *     placeholder and nothing else. The assistant knows the name; it does not
 *     know what is inside.
 */
export type ExtractionFormat =
	| 'html'
	| 'text'
	| 'csv'
	| 'pdf'
	| 'word'
	| 'spreadsheet'
	| 'image'
	| 'file';

/**
 * Classify a file by its MIME type and name.
 *
 * ORDER IS THE POLICY, and it is the extractor's own: `text/html` before the
 * generic `text/*` (HTML starts with `text/`, and checking the generic branch
 * first would feed raw markup — `<script>` bodies included — straight into the
 * LLM and knowledge-graph ingestion path), then JSON, then CSV and PDF, each
 * of which is accepted by type OR by extension.
 */
export function classifyExtraction(mimeType: string, filename: string): ExtractionFormat {
	const name = filename.toLowerCase();
	if (mimeType === 'text/html') return 'html';
	if (mimeType.startsWith('text/') || mimeType === 'application/json') {
		return mimeType === 'text/csv' ? 'csv' : 'text';
	}
	if (mimeType === 'text/csv' || name.endsWith('.csv')) return 'csv';
	if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
	if (
		mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		mimeType === 'application/msword'
	) {
		return 'word';
	}
	if (
		mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		mimeType === 'application/vnd.ms-excel'
	) {
		return 'spreadsheet';
	}
	if (mimeType.startsWith('image/')) return 'image';
	return 'file';
}

/** The `[Kind: filename]` line a format with no readable text answers with. */
export function extractionPlaceholder(format: ExtractionFormat, filename: string): string {
	if (format === 'word') return `[Word document: ${filename}]`;
	if (format === 'spreadsheet') return `[Spreadsheet: ${filename}]`;
	if (format === 'image') return `[Image: ${filename}]`;
	if (format === 'pdf') return `[PDF file: ${filename}]`;
	return `[File: ${filename}]`;
}

/**
 * Does `extractText` pull real content out of this file, rather than returning
 * a `[Kind: filename]` placeholder?
 *
 * PDF IS ANSWERED BY NAME, and it is the one format where that can be wrong: a
 * scanned-image or encrypted PDF parses to no text and the extractor falls back
 * to `[PDF file: scan.pdf]`, while this still says true — so the row reads
 * `indexed` for a file the assistant only knows the name of. Deciding it
 * honestly needs the BYTES through `unpdf`, which only the `'use node'`
 * extractor can run; the capture path that consults this predicate has the
 * bytes but not the runtime. `__tests__/semanticFileExtraction.test.ts` pins
 * both halves of that.
 */
export function hasTextExtraction(mimeType: string, filename: string): boolean {
	const format = classifyExtraction(mimeType, filename);
	return format === 'html' || format === 'text' || format === 'csv' || format === 'pdf';
}
