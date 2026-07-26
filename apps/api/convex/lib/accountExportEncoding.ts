/** Encode arbitrary export bytes without overflowing the argument limit of
 * `String.fromCharCode` for large bodies or attachments. */
export function accountExportBytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}
