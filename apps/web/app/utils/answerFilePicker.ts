/**
 * "Upload" on an Answer mode file question (plan §06, §08): the OS file picker,
 * which on a phone also offers the camera, so a paper invoice gets in as a
 * photo.
 *
 * Two choices here matter on phones:
 *   - No `capture` attribute. `capture` makes a phone skip the picker and open
 *     the camera directly, which takes away the PDF already in Files or
 *     Downloads. Without it iOS and Android offer camera, photo library and
 *     files in one sheet.
 *   - Named image types, not `image/*`. iPhone photos are HEIC, which the
 *     upload policy (`DEFAULT_FILE_POLICY` in @owlat/email-scanner, the one
 *     `semanticFiles.create` and the ask's file answer enforce) does not take.
 *     When `accept` names JPEG but not HEIC, iOS converts the photo to JPEG as
 *     it hands it over; `image/*` would let the HEIC through to be refused.
 *
 * The accepted set is the policy's images, PDF and office documents: what
 * someone is asked for in a reply (invoice, contract, scan, spreadsheet).
 */

const ACCEPTED: ReadonlyArray<{ mime: string; extensions: readonly string[] }> = [
	{ mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
	{ mime: 'image/png', extensions: ['.png'] },
	{ mime: 'image/webp', extensions: ['.webp'] },
	{ mime: 'image/gif', extensions: ['.gif'] },
	{ mime: 'application/pdf', extensions: ['.pdf'] },
	{ mime: 'application/msword', extensions: ['.doc'] },
	{
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		extensions: ['.docx'],
	},
	{ mime: 'application/vnd.oasis.opendocument.text', extensions: ['.odt'] },
	{ mime: 'application/vnd.ms-excel', extensions: ['.xls'] },
	{
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		extensions: ['.xlsx'],
	},
	{ mime: 'application/vnd.oasis.opendocument.spreadsheet', extensions: ['.ods'] },
	{ mime: 'text/csv', extensions: ['.csv'] },
	{ mime: 'text/plain', extensions: ['.txt'] },
];

/**
 * The `accept` attribute: every MIME type and extension. Extensions as well,
 * because some Android file providers report office files as
 * `application/octet-stream` and are filtered by name.
 */
export const ANSWER_UPLOAD_ACCEPT = ACCEPTED.flatMap((entry) => [
	entry.mime,
	...entry.extensions,
]).join(',');

/**
 * Would the upload be taken? Checked before uploading, so a file the picker
 * let through anyway (a desktop "All files" choice, a drop) gets a clear
 * refusal in the ask card instead of a failed upload.
 */
export function isAcceptedAnswerUpload(file: { name: string; type: string }): boolean {
	const type = file.type.toLowerCase();
	if (type && ACCEPTED.some((entry) => entry.mime === type)) return true;
	const name = file.name.toLowerCase();
	return ACCEPTED.some((entry) => entry.extensions.some((ext) => name.endsWith(ext)));
}

/**
 * Open the picker and resolve with the chosen file, or null when it is closed
 * without one. Call it synchronously from the tap's handler: browsers open a
 * file picker only inside a user gesture.
 *
 * A detached `<input type="file">` does the work, so the ask card needs no
 * hidden input in its template. `cancel` (fired by current browsers when the
 * picker closes empty) settles the promise; where it is not fired, the promise
 * simply stays pending, which holds nothing but the closure.
 */
export function pickAnswerFile(doc: Document = document): Promise<File | null> {
	return new Promise((resolve) => {
		const input = doc.createElement('input');
		input.type = 'file';
		input.accept = ANSWER_UPLOAD_ACCEPT;
		input.addEventListener(
			'change',
			() => {
				resolve(input.files?.[0] ?? null);
			},
			{ once: true }
		);
		input.addEventListener('cancel', () => resolve(null), { once: true });
		input.click();
	});
}
