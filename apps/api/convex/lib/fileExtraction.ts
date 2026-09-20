/**
 * Which uploaded/captured file types yield REAL text, and which only yield
 * their own name.
 *
 * `semanticFileProcessing.extractText` answers a Word document with
 * `[Word document: contract.docx]`, a spreadsheet with `[Spreadsheet: q3.xlsx]`
 * and an image with `[Image: scan.png]`. Those files are still ingested —
 * summarised, tagged, embedded — but everything downstream is working from a
 * filename, so an inbound `.docx` that "indexed" cleanly reads to the user
 * exactly like a PDF whose contents the assistant actually has. This predicate
 * is what lets the capture path say which of the two happened.
 *
 * Deliberately NOT a copy of the branch list in `semanticFileProcessing`: that
 * module is `'use node'`, so the ingest path (V8 isolate) cannot import it.
 * `__tests__/semanticFileExtraction.test.ts` pins the two against each other by
 * running the real extractor over a table of types.
 */

/**
 * Does `extractText` pull real content out of this file, rather than returning
 * a `[Kind: filename]` placeholder?
 *
 * Mirrors the extractor's own order: `text/html` before the generic `text/*`,
 * then JSON, CSV (by type or extension) and PDF (by type or extension).
 *
 * PDF IS ANSWERED BY NAME, and it is the one type where that can be wrong: a
 * scanned-image or encrypted PDF parses to no text and the extractor falls back
 * to `[PDF file: scan.pdf]`, while this still says true — so the row reads
 * `indexed` for a file the assistant only knows the name of. Deciding it
 * honestly needs the BYTES through `unpdf`, which lives in the `'use node'`
 * extractor this V8-side predicate exists precisely because it cannot import.
 * `__tests__/semanticFileExtraction.test.ts` pins both halves of that.
 */
export function hasTextExtraction(mimeType: string, filename: string): boolean {
	const name = filename.toLowerCase();
	if (mimeType === 'text/html') return true;
	if (mimeType.startsWith('text/') || mimeType === 'application/json') return true;
	if (mimeType === 'text/csv' || name.endsWith('.csv')) return true;
	if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return true;
	return false;
}
