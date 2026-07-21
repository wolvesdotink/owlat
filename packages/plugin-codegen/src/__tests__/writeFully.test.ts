import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface WriteResult {
	readonly bytesWritten: number;
}

interface WritableFile {
	write(chunk: Uint8Array, offset: number, length: number, position: number): Promise<WriteResult>;
}

type WriteFully = (file: WritableFile, chunk: Uint8Array, fileOffset: number) => Promise<number>;

async function loadWriteFully(): Promise<WriteFully> {
	const testDirectory = dirname(fileURLToPath(import.meta.url));
	const moduleUrl = pathToFileURL(resolve(testDirectory, '../writeFully.mjs')).href;
	const module: unknown = await import(moduleUrl);
	if (!isRecord(module) || typeof module['writeFully'] !== 'function') {
		throw new Error('writeFully helper does not export its write function');
	}
	return module['writeFully'] as WriteFully;
}

describe('complete atomic output writes', () => {
	it('advances source and file offsets until a partial-writing handle consumes the chunk', async () => {
		const writeFully = await loadWriteFully();
		const source = Buffer.from('partial writes must remain complete');
		const output = Buffer.alloc(source.byteLength);
		const positions: number[] = [];
		const file: WritableFile = {
			async write(chunk, offset, length, position) {
				const bytesWritten = Math.min(3, length);
				positions.push(position);
				output.set(chunk.subarray(offset, offset + bytesWritten), position);
				return { bytesWritten };
			},
		};

		const finalOffset = await writeFully(file, source, 0);

		expect(output).toEqual(source);
		expect(finalOffset).toBe(source.byteLength);
		expect(positions).toEqual(
			Array.from({ length: Math.ceil(source.byteLength / 3) }, (_, index) => index * 3)
		);
	});

	it('rejects a zero-progress write instead of committing truncated output', async () => {
		const writeFully = await loadWriteFully();
		const file: WritableFile = {
			async write() {
				return { bytesWritten: 0 };
			},
		};

		await expect(writeFully(file, Buffer.from('must be complete'), 0)).rejects.toThrow(
			'zero progress'
		);
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
