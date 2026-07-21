/** Write one input chunk completely, including runtimes that report partial writes. */
export async function writeFully(file, chunk, fileOffset) {
	let sourceOffset = 0;
	while (sourceOffset < chunk.byteLength) {
		const remaining = chunk.byteLength - sourceOffset;
		const { bytesWritten } = await file.write(chunk, sourceOffset, remaining, fileOffset);
		if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
			throw new Error('Atomic output write made invalid or zero progress');
		}
		sourceOffset += bytesWritten;
		fileOffset += bytesWritten;
	}
	return fileOffset;
}
