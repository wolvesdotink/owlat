import { describe, expect, it } from 'vitest';
import {
	QR_MAX_BYTES,
	eccForBlock,
	encodeQrMatrix,
	formatBits,
	openpgpFingerprintUri,
	qrMatrixToSvgPath,
} from '../postboxQrCode';

/**
 * The encoder is only worth having if a phone can read what it draws, and a
 * matrix of booleans looks plausible whether or not it scans. So the core test
 * here is a ROUND TRIP: a reader written independently below — from the spec's
 * placement rules, not from the encoder's helpers — walks the produced matrix
 * back to the bytes that went in. If the mask, the zig-zag, the reserved-module
 * map or the block interleave were wrong in any way, the payload would not come
 * back out.
 *
 * The format-information vectors are the published Table C.1 strings for error
 * level M, which pins the BCH code against the standard rather than against
 * itself.
 */

// ─── An independent reader, derived from the spec, not from the encoder ───────

/** Alignment-pattern centres for versions 1..6 (the range the encoder emits). */
const CENTERS: Record<number, number[]> = {
	1: [],
	2: [6, 18],
	3: [6, 22],
	4: [6, 26],
	5: [6, 30],
	6: [6, 34],
};

/** Which modules are function patterns — the cells the data walk must skip. */
function functionModules(size: number, version: number): boolean[][] {
	const reserved = Array.from({ length: size }, () =>
		Array.from<boolean>({ length: size }).fill(false)
	);
	const mark = (row: number, col: number) => {
		if (row >= 0 && row < size && col >= 0 && col < size) reserved[row]![col] = true;
	};
	// Top-left: the 7x7 finder, its separators, and the format strips — a full 9x9.
	for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) mark(r, c);
	// Top-right: finder + separator (8 columns) and the 8-module format strip on
	// row 8. Column `size - 9` carries DATA, so the block is 9 rows by 8 columns.
	for (let r = 0; r < 9; r++) for (let c = 0; c < 8; c++) mark(r, size - 1 - c);
	// Bottom-left: the mirror image — 8 rows by 9 columns, the ninth column
	// holding the format strip and the always-dark module.
	for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) mark(size - 1 - r, c);
	// Timing patterns.
	for (let i = 0; i < size; i++) {
		mark(6, i);
		mark(i, 6);
	}
	// Alignment patterns, minus the three that collide with a finder.
	const centers = CENTERS[version]!;
	const last = centers[centers.length - 1];
	for (const row of centers) {
		for (const col of centers) {
			if ((row === 6 && col === 6) || (row === 6 && col === last) || (col === 6 && row === last)) {
				continue;
			}
			for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) mark(row + r, col + c);
		}
	}
	return reserved;
}

function maskBit(mask: number, row: number, col: number): boolean {
	const masks = [
		(row + col) % 2 === 0,
		row % 2 === 0,
		col % 3 === 0,
		(row + col) % 3 === 0,
		(Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
		((row * col) % 2) + ((row * col) % 3) === 0,
		(((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
		(((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
	];
	return masks[mask]!;
}

/** Recover the mask index from the first format-information copy. */
function readMask(matrix: boolean[][]): number {
	let bits = 0;
	const bitAt = (row: number, col: number) => (matrix[row]![col] ? 1 : 0);
	for (let i = 0; i <= 5; i++) bits |= bitAt(i, 8) << i;
	bits |= bitAt(7, 8) << 6;
	bits |= bitAt(8, 8) << 7;
	bits |= bitAt(8, 7) << 8;
	for (let i = 9; i < 15; i++) bits |= bitAt(8, 14 - i) << i;
	for (let mask = 0; mask < 8; mask++) if (formatBits(mask) === bits) return mask;
	throw new Error(`no error-level-M format information matches ${bits.toString(2)}`);
}

/** Undo the mask and the zig-zag walk, returning the interleaved codewords. */
function readCodewords(matrix: boolean[][], version: number): number[] {
	const size = matrix.length;
	const reserved = functionModules(size, version);
	const mask = readMask(matrix);
	const bits: number[] = [];
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		const upward = ((right + 1) & 2) === 0;
		for (let step = 0; step < size; step++) {
			const row = upward ? size - 1 - step : step;
			for (const col of [right, right - 1]) {
				if (reserved[row]![col]) continue;
				bits.push(matrix[row]![col] !== maskBit(mask, row, col) ? 1 : 0);
			}
		}
	}
	const codewords: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
		codewords.push(byte);
	}
	return codewords;
}

/** Per-version level-M geometry, mirroring the encoder's own table. */
const GEOMETRY: Record<number, { blocks: number; data: number }> = {
	1: { blocks: 1, data: 16 },
	2: { blocks: 1, data: 28 },
	3: { blocks: 1, data: 44 },
	4: { blocks: 2, data: 32 },
	5: { blocks: 2, data: 43 },
	6: { blocks: 4, data: 27 },
};

/** De-interleave the data codewords and read the byte-mode segment back out. */
function decodePayload(matrix: boolean[][]): string {
	const version = (matrix.length - 17) / 4;
	const { blocks, data } = GEOMETRY[version]!;
	const stream = readCodewords(matrix, version);
	const deinterleaved: number[] = [];
	for (let b = 0; b < blocks; b++) {
		for (let i = 0; i < data; i++) deinterleaved.push(stream[i * blocks + b]!);
	}
	// 4 mode bits + 8 length bits, then the payload — all byte-aligned only after
	// the first nibble, so read through a small bit cursor.
	let cursor = 0;
	const take = (count: number) => {
		let value = 0;
		for (let i = 0; i < count; i++, cursor++) {
			value = (value << 1) | ((deinterleaved[cursor >> 3]! >>> (7 - (cursor & 7))) & 1);
		}
		return value;
	};
	expect(take(4)).toBe(0b0100); // byte mode
	const length = take(8);
	const bytes: number[] = [];
	for (let i = 0; i < length; i++) bytes.push(take(8));
	return new TextDecoder().decode(new Uint8Array(bytes));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('encodeQrMatrix', () => {
	const fingerprint = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';

	it('round-trips a fingerprint URI through the matrix it draws', () => {
		const payload = openpgpFingerprintUri(fingerprint);
		const matrix = encodeQrMatrix(payload);
		expect(matrix).not.toBeNull();
		expect(decodePayload(matrix!)).toBe(payload);
	});

	it('round-trips payloads at every version boundary it can reach', () => {
		// One payload per version 1..6: the smallest one that no longer fits the
		// version below, so each row of the geometry table is actually exercised.
		for (const length of [10, 20, 30, 50, 70, 100]) {
			const payload = 'X'.repeat(length);
			const matrix = encodeQrMatrix(payload);
			expect(matrix).not.toBeNull();
			expect(decodePayload(matrix!)).toBe(payload);
		}
	});

	it('picks the smallest version that fits, and grows when it must', () => {
		expect(encodeQrMatrix('X'.repeat(10))!.length).toBe(21); // version 1
		expect(encodeQrMatrix('X'.repeat(20))!.length).toBe(25); // version 2
		expect(encodeQrMatrix('X'.repeat(100))!.length).toBe(41); // version 6
	});

	it('draws the three finder patterns and the timing rows', () => {
		const matrix = encodeQrMatrix(openpgpFingerprintUri(fingerprint))!;
		const size = matrix.length;
		for (const [row, col] of [
			[0, 0],
			[0, size - 7],
			[size - 7, 0],
		] as const) {
			expect(matrix[row]![col]).toBe(true); // outer ring
			expect(matrix[row + 1]![col + 1]).toBe(false); // light ring
			expect(matrix[row + 3]![col + 3]).toBe(true); // dark core
		}
		// Separators around the top-left finder are light.
		expect(matrix[7]![0]).toBe(false);
		expect(matrix[0]![7]).toBe(false);
		// Timing patterns alternate, starting dark at the finder edge.
		for (let i = 8; i < size - 8; i++) {
			expect(matrix[6]![i]).toBe(i % 2 === 0);
			expect(matrix[i]![6]).toBe(i % 2 === 0);
		}
		// The always-dark module below the top-left finder.
		expect(matrix[size - 8]![8]).toBe(true);
	});

	it('draws the alignment pattern a scanner uses to correct for perspective', () => {
		// Asserted directly rather than via the round trip: the reader below skips
		// the same modules the encoder reserves, so an encoder that RESERVED the
		// alignment square without DRAWING it would still decode perfectly here and
		// fail on every real camera.
		const matrix = encodeQrMatrix('X'.repeat(50))!; // version 4, centre at (26, 26)
		expect(matrix.length).toBe(33);
		expect(matrix[26]![26]).toBe(true); // dark centre
		expect(matrix[25]![26]).toBe(false); // light ring
		expect(matrix[26]![25]).toBe(false);
		expect(matrix[24]![26]).toBe(true); // dark outer ring
		expect(matrix[24]![24]).toBe(true);
		expect(matrix[28]![28]).toBe(true);
	});

	it('writes the same format information into both copies', () => {
		const matrix = encodeQrMatrix(openpgpFingerprintUri(fingerprint))!;
		const size = matrix.length;
		const bits = formatBits(readMask(matrix));
		for (let i = 0; i < 8; i++) {
			expect(matrix[8]![size - 1 - i]).toBe(((bits >>> i) & 1) === 1);
		}
		for (let i = 8; i < 15; i++) {
			expect(matrix[size - 15 + i]![8]).toBe(((bits >>> i) & 1) === 1);
		}
	});

	it('refuses a payload it cannot hold rather than drawing an unscannable code', () => {
		expect(encodeQrMatrix('X'.repeat(QR_MAX_BYTES))).not.toBeNull();
		expect(encodeQrMatrix('X'.repeat(QR_MAX_BYTES + 1))).toBeNull();
	});

	it('is deterministic — the same payload always draws the same code', () => {
		const a = encodeQrMatrix('owlat')!;
		const b = encodeQrMatrix('owlat')!;
		expect(a).toEqual(b);
	});
});

describe('formatBits', () => {
	// ISO/IEC 18004 Table C.1, the error-correction-level-M rows.
	const TABLE = [
		'101010000010010',
		'101000100100101',
		'101111001111100',
		'101101101001011',
		'100010111111001',
		'100000011001110',
		'100111110010111',
		'100101010100000',
	];

	it('matches the published format-information strings for level M', () => {
		TABLE.forEach((expected, mask) => {
			expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(expected);
		});
	});
});

describe('eccForBlock', () => {
	it('matches the published Reed-Solomon vector for version 1, level M', () => {
		// The reference encoding of "01234567": the sixteen data codewords of a
		// version-1-M symbol and the ten error-correction codewords they produce.
		const data = [
			0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
			0x11,
		];
		expect(eccForBlock(data, 10)).toEqual([
			0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
		]);
	});
});

describe('openpgpFingerprintUri', () => {
	it('normalises spacing and case so a scan equals the pinned fingerprint', () => {
		expect(openpgpFingerprintUri('a1b2 c3d4')).toBe('OPENPGP4FPR:A1B2C3D4');
	});
});

describe('qrMatrixToSvgPath', () => {
	it('emits one square per dark module, offset by the quiet zone', () => {
		const path = qrMatrixToSvgPath(
			[
				[true, false],
				[false, true],
			],
			1
		);
		expect(path).toBe('M1 1h1v1h-1zM2 2h1v1h-1z');
	});

	it('draws nothing for an all-light matrix', () => {
		expect(qrMatrixToSvgPath([[false, false]])).toBe('');
	});
});
