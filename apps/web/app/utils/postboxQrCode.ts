/**
 * A tiny, dependency-free QR encoder — just enough of ISO/IEC 18004 to draw the
 * fingerprint of a correspondent's sealing key on screen so two people can
 * compare keys with a phone camera (plan idea 54).
 *
 * WHY NOT A LIBRARY. The one payload this ever encodes is an
 * `OPENPGP4FPR:<40 hex>` URI: ~50 ASCII bytes, fixed alphabet, no logos, no
 * styling, no image output. Every QR package on npm carries canvas/PNG paths
 * and a much larger attack surface than the forty-odd lines of GF(256)
 * arithmetic below, for a surface that must keep working offline in a sealed
 * mail client. So this encodes exactly the subset that payload needs and
 * nothing else:
 *
 *   - BYTE mode only (the payload is ASCII; alphanumeric mode would save space
 *     we do not need and adds a second code path to get wrong);
 *   - error-correction level M (~15% recovery — the usual choice for a code
 *     read off a screen);
 *   - versions 1..6 (up to 106 payload bytes, twice what a fingerprint URI
 *     needs). Stopping below 7 is deliberate: version 7 and up must also carry
 *     an 18-bit version-information block, an entire extra mechanism this file
 *     would otherwise have to implement and could not exercise.
 *
 * The output is a plain boolean matrix (`true` = dark module). Rendering is the
 * caller's business — the Vue side draws it as an SVG — which keeps this file
 * pure and unit-testable without a DOM.
 */

/** Error-correction level M, the only level this encoder emits. */
const EC_LEVEL_M_BITS = 0b00;

/**
 * Per-version block geometry for level M, versions 1..6. `dataCodewords` and
 * `ecCodewords` are PER BLOCK; every block in these versions holds the same
 * count (the mixed group-1/group-2 sizes only appear in higher versions, which
 * this encoder does not emit).
 */
interface VersionSpec {
	version: number;
	blocks: number;
	dataCodewords: number;
	ecCodewords: number;
}

const VERSIONS: readonly VersionSpec[] = [
	{ version: 1, blocks: 1, dataCodewords: 16, ecCodewords: 10 },
	{ version: 2, blocks: 1, dataCodewords: 28, ecCodewords: 16 },
	{ version: 3, blocks: 1, dataCodewords: 44, ecCodewords: 26 },
	{ version: 4, blocks: 2, dataCodewords: 32, ecCodewords: 18 },
	{ version: 5, blocks: 2, dataCodewords: 43, ecCodewords: 24 },
	{ version: 6, blocks: 4, dataCodewords: 27, ecCodewords: 16 },
];

/** Alignment-pattern centre coordinates per version (version 1 has none). */
const ALIGNMENT_CENTERS: Record<number, number[]> = {
	1: [],
	2: [6, 18],
	3: [6, 22],
	4: [6, 26],
	5: [6, 30],
	6: [6, 34],
};

/** The largest payload this encoder can hold, in bytes (version 6, level M). */
export const QR_MAX_BYTES = 106;

// ─── GF(256) arithmetic ───────────────────────────────────────────────────────
// Reed-Solomon over the QR field: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** The Reed-Solomon generator polynomial of the given degree. */
function generatorPoly(degree: number): number[] {
	let poly = [1];
	for (let i = 0; i < degree; i++) {
		// Multiply by (x + α^i): coefficients are descending, so the shifted term
		// lands on the SAME index and the scaled one on the next.
		const next = new Array<number>(poly.length + 1).fill(0);
		for (let j = 0; j < poly.length; j++) {
			next[j] = (next[j] as number) ^ (poly[j] as number);
			next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, EXP[i] as number);
		}
		poly = next;
	}
	return poly;
}

/**
 * The `degree` error-correction codewords for one data block. Exported so the
 * test can pin it against a published vector — a scanner rejects a code whose
 * ECC is wrong, and the round-trip decode alone would not notice.
 */
export function eccForBlock(data: readonly number[], degree: number): number[] {
	const gen = generatorPoly(degree);
	const remainder = new Array<number>(degree).fill(0);
	for (const byte of data) {
		const factor = byte ^ (remainder[0] as number);
		remainder.shift();
		remainder.push(0);
		if (factor !== 0) {
			for (let i = 0; i < degree; i++) {
				remainder[i] = (remainder[i] as number) ^ gfMul(gen[i + 1] as number, factor);
			}
		}
	}
	return remainder;
}

// ─── Bit stream ───────────────────────────────────────────────────────────────

class BitBuffer {
	private bits: number[] = [];

	push(value: number, length: number): void {
		for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
	}

	get length(): number {
		return this.bits.length;
	}

	/** Pad to a whole byte and materialise the codewords. */
	toCodewords(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.bits.length; i += 8) {
			let byte = 0;
			for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
			out.push(byte);
		}
		return out;
	}
}

/** UTF-8 bytes of `text` — the payload the byte-mode segment carries. */
function utf8Bytes(text: string): number[] {
	return Array.from(new TextEncoder().encode(text));
}

/** The smallest version 1..6 whose level-M capacity holds `byteLength` bytes. */
function pickVersion(byteLength: number): VersionSpec | null {
	for (const spec of VERSIONS) {
		// 4 mode bits + 8 character-count bits = 12 bits of header for versions < 10.
		const capacityBits = spec.blocks * spec.dataCodewords * 8 - 12;
		if (byteLength * 8 <= capacityBits) return spec;
	}
	return null;
}

/** Encode the payload into the version's full, interleaved codeword stream. */
function buildCodewords(bytes: number[], spec: VersionSpec): number[] {
	const totalData = spec.blocks * spec.dataCodewords;
	const buffer = new BitBuffer();
	buffer.push(0b0100, 4); // byte mode
	buffer.push(bytes.length, 8); // character count (8 bits for versions 1..9)
	for (const byte of bytes) buffer.push(byte, 8);
	// Terminator: up to four zero bits, then pad to a byte boundary.
	buffer.push(0, Math.min(4, totalData * 8 - buffer.length));
	if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

	const data = buffer.toCodewords();
	// Alternating pad codewords, per the spec.
	for (let i = 0; data.length < totalData; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

	const dataBlocks: number[][] = [];
	const ecBlocks: number[][] = [];
	for (let b = 0; b < spec.blocks; b++) {
		const block = data.slice(b * spec.dataCodewords, (b + 1) * spec.dataCodewords);
		dataBlocks.push(block);
		ecBlocks.push(eccForBlock(block, spec.ecCodewords));
	}

	// Interleave: column-major across blocks, data first then error correction.
	const result: number[] = [];
	for (let i = 0; i < spec.dataCodewords; i++) {
		for (const block of dataBlocks) result.push(block[i] as number);
	}
	for (let i = 0; i < spec.ecCodewords; i++) {
		for (const block of ecBlocks) result.push(block[i] as number);
	}
	return result;
}

// ─── Matrix construction ──────────────────────────────────────────────────────

type Grid = (boolean | null)[][];

function placeFinder(grid: Grid, row: number, col: number): void {
	for (let r = -1; r <= 7; r++) {
		for (let c = -1; c <= 7; c++) {
			const y = row + r;
			const x = col + c;
			if (y < 0 || y >= grid.length || x < 0 || x >= grid.length) continue;
			// The -1/+7 ring is the SEPARATOR and is always light; only the 7x7
			// finder itself carries the ring-and-core pattern.
			const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
			const onRing = r === 0 || r === 6 || c === 0 || c === 6;
			const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
			(grid[y] as (boolean | null)[])[x] = inFinder && (onRing || inCore);
		}
	}
}

function placeAlignment(grid: Grid, version: number): void {
	const centers = ALIGNMENT_CENTERS[version] ?? [];
	for (const row of centers) {
		for (const col of centers) {
			// The three finder corners already own their neighbourhoods.
			const atFinder =
				(row === 6 && col === 6) ||
				(row === 6 && col === centers[centers.length - 1]) ||
				(col === 6 && row === centers[centers.length - 1]);
			if (atFinder) continue;
			for (let r = -2; r <= 2; r++) {
				for (let c = -2; c <= 2; c++) {
					const ring = Math.max(Math.abs(r), Math.abs(c));
					(grid[row + r] as (boolean | null)[])[col + c] = ring !== 1;
				}
			}
		}
	}
}

/** Finder, separator, timing, alignment and the reserved format areas. */
function buildFunctionPatterns(size: number, version: number): Grid {
	const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
	placeFinder(grid, 0, 0);
	placeFinder(grid, 0, size - 7);
	placeFinder(grid, size - 7, 0);
	placeAlignment(grid, version);
	for (let i = 8; i < size - 8; i++) {
		const dark = i % 2 === 0;
		(grid[6] as (boolean | null)[])[i] = dark;
		(grid[i] as (boolean | null)[])[6] = dark;
	}
	// Reserve the format-information strips (written after masking) and the
	// always-dark module below the top-left finder.
	for (let i = 0; i < 9; i++) {
		if ((grid[8] as (boolean | null)[])[i] === null) (grid[8] as (boolean | null)[])[i] = false;
		if ((grid[i] as (boolean | null)[])[8] === null) (grid[i] as (boolean | null)[])[8] = false;
	}
	for (let i = 0; i < 8; i++) {
		(grid[8] as (boolean | null)[])[size - 1 - i] = false;
		(grid[size - 1 - i] as (boolean | null)[])[8] = false;
	}
	(grid[size - 8] as (boolean | null)[])[8] = true;
	return grid;
}

/** Which modules are function patterns (never masked, never data). */
function reservedMap(size: number, version: number): boolean[][] {
	const grid = buildFunctionPatterns(size, version);
	return grid.map((row) => row.map((cell) => cell !== null));
}

function maskBit(mask: number, row: number, col: number): boolean {
	switch (mask) {
		case 0:
			return (row + col) % 2 === 0;
		case 1:
			return row % 2 === 0;
		case 2:
			return col % 3 === 0;
		case 3:
			return (row + col) % 3 === 0;
		case 4:
			return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5:
			return ((row * col) % 2) + ((row * col) % 3) === 0;
		case 6:
			return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
		default:
			return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
	}
}

/** Zig-zag the codeword bits into the free modules, applying the mask as we go. */
function placeData(grid: Grid, reserved: boolean[][], codewords: number[], mask: number): void {
	const size = grid.length;
	let bitIndex = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		// Column 6 is the vertical timing pattern; the pair that would straddle it
		// shifts one to the left instead of skipping a column of data.
		if (right === 6) right = 5;
		const upward = ((right + 1) & 2) === 0;
		for (let step = 0; step < size; step++) {
			const row = upward ? size - 1 - step : step;
			for (const col of [right, right - 1]) {
				if ((reserved[row] as boolean[])[col]) continue;
				const byte = codewords[bitIndex >> 3] ?? 0;
				const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
				bitIndex++;
				(grid[row] as (boolean | null)[])[col] = bit !== maskBit(mask, row, col);
			}
		}
	}
}

/** BCH(15,5) format information for level M and the chosen mask. */
export function formatBits(mask: number): number {
	const data = (EC_LEVEL_M_BITS << 3) | mask;
	let remainder = data;
	for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
	return ((data << 10) | remainder) ^ 0x5412;
}

function writeFormat(grid: Grid, mask: number): void {
	const size = grid.length;
	const bits = formatBits(mask);
	const set = (row: number, col: number, bit: boolean) => {
		(grid[row] as (boolean | null)[])[col] = bit;
	};
	const bitAt = (i: number) => ((bits >>> i) & 1) === 1;
	// Copy 1, wrapped around the top-left finder.
	for (let i = 0; i <= 5; i++) set(i, 8, bitAt(i));
	set(7, 8, bitAt(6));
	set(8, 8, bitAt(7));
	set(8, 7, bitAt(8));
	for (let i = 9; i < 15; i++) set(8, 14 - i, bitAt(i));
	// Copy 2, split between the other two finders.
	for (let i = 0; i < 8; i++) set(8, size - 1 - i, bitAt(i));
	for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bitAt(i));
	// The always-dark module below the top-left finder.
	set(size - 8, 8, true);
}

// ─── Mask selection ───────────────────────────────────────────────────────────

const FINDER_RUN = [true, false, true, true, true, false, true, false, false, false, false];

function runPenalty(line: boolean[]): number {
	let penalty = 0;
	let run = 1;
	for (let i = 1; i <= line.length; i++) {
		if (i < line.length && line[i] === line[i - 1]) {
			run++;
			continue;
		}
		if (run >= 5) penalty += 3 + (run - 5);
		run = 1;
	}
	// Rule 3: the 1:1:3:1:1 finder-lookalike, in either direction.
	for (let i = 0; i + FINDER_RUN.length <= line.length; i++) {
		const forward = FINDER_RUN.every((bit, j) => line[i + j] === bit);
		const backward = FINDER_RUN.every((bit, j) => line[i + FINDER_RUN.length - 1 - j] === bit);
		if (forward || backward) penalty += 40;
	}
	return penalty;
}

function penalty(matrix: boolean[][]): number {
	const size = matrix.length;
	let total = 0;
	let dark = 0;
	for (let row = 0; row < size; row++) {
		total += runPenalty(matrix[row] as boolean[]);
		total += runPenalty(matrix.map((r) => (r as boolean[])[row] as boolean));
		for (const cell of matrix[row] as boolean[]) if (cell) dark++;
	}
	// Rule 2: every 2x2 block of one colour.
	for (let row = 0; row + 1 < size; row++) {
		for (let col = 0; col + 1 < size; col++) {
			const a = (matrix[row] as boolean[])[col];
			if (
				a === (matrix[row] as boolean[])[col + 1] &&
				a === (matrix[row + 1] as boolean[])[col] &&
				a === (matrix[row + 1] as boolean[])[col + 1]
			) {
				total += 3;
			}
		}
	}
	// Rule 4: deviation from an even split of dark and light modules.
	const ratio = (dark * 100) / (size * size);
	total += Math.floor(Math.abs(ratio - 50) / 5) * 10;
	return total;
}

/**
 * Encode `text` as a QR matrix (`true` = dark). Returns `null` when the payload
 * is longer than {@link QR_MAX_BYTES}, so a caller can fall back to text rather
 * than render a code that would not scan.
 */
export function encodeQrMatrix(text: string): boolean[][] | null {
	const bytes = utf8Bytes(text);
	const spec = pickVersion(bytes.length);
	if (!spec) return null;
	const size = spec.version * 4 + 17;
	const codewords = buildCodewords(bytes, spec);
	const reserved = reservedMap(size, spec.version);

	let best: boolean[][] | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		const grid = buildFunctionPatterns(size, spec.version);
		placeData(grid, reserved, codewords, mask);
		writeFormat(grid, mask);
		const matrix = grid.map((row) => row.map((cell) => cell === true));
		const score = penalty(matrix);
		if (score < bestScore) {
			bestScore = score;
			best = matrix;
		}
	}
	return best;
}

/**
 * The `OPENPGP4FPR:` URI other OpenPGP tools scan (GnuPG, OpenKeychain). Upper
 * case, whitespace stripped — the same normalisation the pin comparison uses, so
 * a scanned code and a pinned fingerprint are the same string.
 */
export function openpgpFingerprintUri(fingerprint: string): string {
	return `OPENPGP4FPR:${fingerprint.replace(/\s+/g, '').toUpperCase()}`;
}

/**
 * An SVG `path` `d` attribute drawing every dark module as a 1x1 square, with
 * `quietZone` modules of margin. One string means the whole code is a single DOM
 * node instead of several hundred `<rect>`s.
 */
export function qrMatrixToSvgPath(matrix: boolean[][], quietZone = 2): string {
	const parts: string[] = [];
	for (let row = 0; row < matrix.length; row++) {
		const line = matrix[row] as boolean[];
		for (let col = 0; col < line.length; col++) {
			if (line[col]) parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
		}
	}
	return parts.join('');
}
