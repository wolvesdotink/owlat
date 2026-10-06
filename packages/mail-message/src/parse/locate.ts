/**
 * The MIME walker of `./body.ts`, over BYTES: locate every part of a raw
 * message without turning the message into a string, then transfer-decode one
 * chosen part at a time straight into a byte array of its exact size.
 *
 * `parseMimeTreeWithBounds` needs the whole message as a binary string and its
 * leaves carry their bodies as strings, so a caller that wants one attachment
 * out of a large message pays for the message several times over (the string,
 * every leaf body, the CRLF-normalized copies, the decode). A forward of a
 * 50 MiB message, or of a few MiB of pathological quoted-printable, does not
 * fit an action's memory that way. Here the message stays the `Uint8Array` it
 * was read as: lines are found with byte searches, only header blocks and
 * delimiter lines become (short) strings, and a leaf records the byte range of
 * its body.
 *
 * SAME TREE. This is the forward pass of `parseMimeNode`, step for step: the
 * same header-block rule, delimiter matching (outermost container first,
 * trailing spaces and tabs ignored), part and depth bounds (`truncated`), and
 * `message/*` / top-level bodies kept verbatim while every other nested body is
 * CRLF -> LF normalized before decoding. Header blocks and delimiter lines are
 * decoded with the same `TextDecoder('latin1')` the string callers use, so
 * `parseHeaders` sees the same text. The nodes are {@link MimeNode}s (with an
 * empty `rawBody`), so `walkLeaves`, `isAttachmentPart`, `partFilename` and
 * `partDisposition` apply unchanged and leaf order, and with it every
 * `partIndex`, is the walker's. `locate.test.ts` holds the two to the same
 * answers.
 *
 * DECODING. {@link decodedLength} counts a body's decoded size without
 * allocating, so a caller can refuse a part over its limit before decoding it;
 * {@link decodeLocated} then decodes into an array of exactly that size.
 * Unlike the string path, 8-bit bytes are copied exactly (the string path maps
 * 0x80-0x9F through windows-1252 before taking the low byte).
 */

import { parseHeaders, getRawParam } from './headers';
import { MAX_DEPTH, MAX_MIME_PARTS, type MimeNode } from './body';

/** Where a located node's body is, in the message's bytes. */
export interface LocatedBody {
	start: number;
	end: number;
	/** CRLF -> LF before decoding (a nested, non-`message/*` leaf). */
	normalize: boolean;
}

/** A located message: the walker's tree, each leaf's body range, and the bounds flag. */
export interface LocatedTree {
	root: MimeNode;
	/** Body range of every leaf node. */
	bodies: WeakMap<MimeNode, LocatedBody>;
	/** The part or depth bound left content out (as `parseMimeTreeWithBounds` reports). */
	truncated: boolean;
}

interface Container {
	readonly open: string;
	readonly close: string;
	state: 'preamble' | 'part' | 'ended';
}

interface PartFrame {
	readonly segStart: number;
	readonly depth: number;
	readonly nested: boolean;
	readonly siblings: MimeNode[] | null;
	bodyStart: number;
	pendingHeaderEnd: number;
	node: MimeNode | null;
	container: Container | null;
}

const latin1 = new TextDecoder('latin1');

/** Locate the parts of a raw message (its bytes); see the module comment. */
export function locateMimeTree(raw: Uint8Array): LocatedTree {
	const n = raw.length;
	const text = (start: number, end: number) => latin1.decode(raw.subarray(start, end));
	const bodies = new WeakMap<MimeNode, LocatedBody>();
	const budget = { remainingParts: MAX_MIME_PARTS, truncated: false };
	const frames: PartFrame[] = [
		{
			segStart: 0,
			depth: 0,
			nested: false,
			siblings: null,
			bodyStart: -1,
			pendingHeaderEnd: -1,
			node: null,
			container: null,
		},
	];
	const delimiters = new Map<string, number[]>();
	let prevEnd = -1;

	const register = (key: string, level: number) => {
		const levels = delimiters.get(key);
		if (levels) levels.push(level);
		else delimiters.set(key, [level]);
	};
	const unregister = (key: string) => {
		const levels = delimiters.get(key);
		levels?.pop();
		if (levels?.length === 0) delimiters.delete(key);
	};
	const endContainer = (container: Container) => {
		if (container.state === 'ended') return;
		container.state = 'ended';
		unregister(container.open);
		unregister(container.close);
	};

	const readHeaders = (frame: PartFrame, level: number, headerEnd: number, bodyStart: number) => {
		const headers = parseHeaders(text(frame.segStart, headerEnd));
		const contentType = headers.contentType;
		let container: Container | null = null;
		if (contentType.value.startsWith('multipart/')) {
			const boundary = getRawParam(headers.last('content-type'), 'boundary');
			if (boundary !== undefined && boundary !== '' && frame.depth >= MAX_DEPTH) {
				budget.truncated = true;
			} else if (boundary !== undefined && boundary !== '') {
				container = { open: `--${boundary}`, close: `--${boundary}--`, state: 'preamble' };
				register(container.open, level);
				register(container.close, level);
			}
		}
		const node: MimeNode = {
			headers,
			contentType,
			isMultipart: container !== null,
			children: [],
			rawBody: '',
		};
		frame.node = node;
		frame.container = container;
		frame.bodyStart = bodyStart;
		frame.siblings?.push(node);
	};

	const endPart = (level: number, segEnd: number) => {
		const frame = frames[level] as PartFrame;
		if (frame.bodyStart === -1) readHeaders(frame, level, segEnd, segEnd);
		const node = frame.node as MimeNode;
		if (frame.container) endContainer(frame.container);
		else
			bodies.set(node, {
				start: frame.bodyStart,
				end: Math.max(frame.bodyStart, segEnd),
				normalize: frame.nested && !node.contentType.value.startsWith('message/'),
			});
	};

	const endPartsAbove = (level: number, prevStart: number) => {
		while (frames.length - 1 > level) {
			const frame = frames[frames.length - 1] as PartFrame;
			endPart(frames.length - 1, prevStart >= frame.segStart ? prevEnd : frame.segStart);
			frames.pop();
		}
	};

	const delimiter = (level: number, isOpen: boolean, next: number, prevStart: number) => {
		endPartsAbove(level, prevStart);
		const frame = frames[level] as PartFrame;
		const container = frame.container as Container;
		if (!isOpen) {
			endContainer(container);
			return;
		}
		if (budget.remainingParts <= 0) {
			budget.truncated = true;
			endContainer(container);
			return;
		}
		budget.remainingParts--;
		container.state = 'part';
		frames.push({
			segStart: next,
			depth: frame.depth + 1,
			nested: true,
			siblings: (frame.node as MimeNode).children,
			bodyStart: -1,
			pendingHeaderEnd: -1,
			node: null,
			container: null,
		});
	};

	const delimiterText = (start: number, end: number): string | null => {
		if (end - start < 3 || raw[start] !== 0x2d || raw[start + 1] !== 0x2d) return null;
		while (end > start) {
			const c = raw[end - 1];
			if (c !== 0x20 && c !== 0x09) break;
			end--;
		}
		return text(start, end);
	};

	let prevStart = -1;
	let pos = 0;
	while (pos <= n) {
		const nl = raw.indexOf(0x0a, pos);
		const atEnd = nl === -1;
		const lineEnd = atEnd ? n : nl > pos && raw[nl - 1] === 0x0d ? nl - 1 : nl;
		const next = atEnd ? n + 1 : nl + 1;

		const line = delimiters.size > 0 ? delimiterText(pos, lineEnd) : null;
		const levels = line === null ? undefined : delimiters.get(line);
		if (levels !== undefined) {
			const level = levels[0] as number;
			delimiter(level, line === (frames[level] as PartFrame).container?.open, next, prevStart);
		} else {
			const top = frames[frames.length - 1] as PartFrame;
			if (top.bodyStart === -1) {
				if (top.pendingHeaderEnd !== -1) {
					const level = frames.length - 1;
					readHeaders(top, level, top.pendingHeaderEnd, pos);
					const container = top.container;
					const own = container ? delimiterText(pos, lineEnd) : null;
					if (container && own !== null && (own === container.open || own === container.close)) {
						delimiter(level, own === container.open, next, prevStart);
					}
				} else if (lineEnd === pos && pos > top.segStart && !atEnd) {
					top.pendingHeaderEnd = prevEnd;
				}
			}
		}

		prevStart = pos;
		prevEnd = lineEnd;
		if (atEnd) break;
		pos = next;
	}

	endPartsAbove(0, prevStart);
	endPart(0, n);
	return { root: frames[0]?.node as MimeNode, bodies, truncated: budget.truncated };
}

// ── Transfer decoding over a body range ─────────────────────────────────────

const B64 = new Int8Array(256).fill(-1);
for (const [i, c] of [
	...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
].entries()) {
	B64[c.charCodeAt(0)] = i;
}
const EQ = 0x3d;

function hexValue(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x37;
	if (c >= 0x61 && c <= 0x66) return c - 0x57;
	return -1;
}

/**
 * The body as the string path sees it: CR before LF dropped when normalized.
 * Calls `emit` per byte; returns nothing.
 */
function eachNormalized(raw: Uint8Array, body: LocatedBody, emit: (byte: number) => void): void {
	const { start, end, normalize } = body;
	for (let i = start; i < end; i++) {
		const c = raw[i] as number;
		if (normalize && c === 0x0d && i + 1 < end && raw[i + 1] === 0x0a) continue;
		emit(c);
	}
}

/**
 * base64 as `atob` decodes it after dropping every character outside the
 * alphabet: two trailing `=` at most (only on a length that divides by 4), no
 * `=` elsewhere, and no length of 1 mod 4; anything else decodes to nothing.
 * Returns the number of alphabet characters to decode, or -1 for nothing.
 */
function base64Sextets(raw: Uint8Array, body: LocatedBody): number {
	let count = 0;
	let pads = 0;
	let padBeforeData = false;
	for (let i = body.start; i < body.end; i++) {
		const c = raw[i] as number;
		if (c === EQ) {
			pads++;
		} else if (B64[c] !== -1) {
			if (pads > 0) padBeforeData = true;
			count++;
		}
	}
	const total = count + pads;
	if (padBeforeData) return -1;
	if (pads > 0 && (total % 4 !== 0 || pads > 2)) return -1;
	if (count % 4 === 1) return -1;
	return count;
}

/** The quoted-printable decode of the string path, as a stream of bytes. */
function eachQuotedPrintable(
	raw: Uint8Array,
	body: LocatedBody,
	emit: (byte: number) => void
): void {
	// Stage 1: the normalized body. Stage 2: soft line breaks (`=\r?\n`) removed.
	// Stage 3: `=HH` decoded. Each stage reads the previous one left to right,
	// as the string path's regex replaces do; a small window holds the lookahead.
	const s1: number[] = [];
	let s1Head = 0;
	const s2: number[] = [];
	let s2Head = 0;
	let i = body.start;
	const pull1 = (): boolean => {
		while (i < body.end) {
			const c = raw[i] as number;
			i++;
			if (body.normalize && c === 0x0d && i < body.end && raw[i] === 0x0a) continue;
			s1.push(c);
			return true;
		}
		return false;
	};
	const need1 = (k: number) => {
		while (s1.length - s1Head < k) {
			if (!pull1()) break;
		}
		return s1.length - s1Head >= k;
	};
	const pull2 = (): boolean => {
		for (;;) {
			if (!need1(1)) return false;
			const c = s1[s1Head] as number;
			if (c === EQ && need1(2) && s1[s1Head + 1] === 0x0a) {
				s1Head += 2;
				continue;
			}
			if (c === EQ && need1(3) && s1[s1Head + 1] === 0x0d && s1[s1Head + 2] === 0x0a) {
				s1Head += 3;
				continue;
			}
			s1Head++;
			s2.push(c);
			if (s1Head > 4096) {
				s1.splice(0, s1Head);
				s1Head = 0;
			}
			return true;
		}
	};
	const need2 = (k: number) => {
		while (s2.length - s2Head < k && pull2());
		return s2.length - s2Head >= k;
	};
	while (need2(1)) {
		const c = s2[s2Head] as number;
		if (c === EQ && need2(3)) {
			const hi = hexValue(s2[s2Head + 1] as number);
			const lo = hexValue(s2[s2Head + 2] as number);
			if (hi !== -1 && lo !== -1) {
				emit((hi << 4) | lo);
				s2Head += 3;
				continue;
			}
		}
		emit(c);
		s2Head++;
		if (s2Head > 4096) {
			s2.splice(0, s2Head);
			s2Head = 0;
		}
	}
}

/** Walk a body's decoded bytes (without keeping them) under its transfer encoding. */
function eachDecoded(
	raw: Uint8Array,
	body: LocatedBody,
	encoding: string | undefined,
	emit: (byte: number) => void
): void {
	const enc = (encoding ?? '7bit').toLowerCase().trim();
	if (enc === 'base64') {
		const sextets = base64Sextets(raw, body);
		if (sextets <= 0) return;
		let acc = 0;
		let bits = 0;
		let seen = 0;
		for (let i = body.start; i < body.end && seen < sextets; i++) {
			const v = B64[raw[i] as number] as number;
			if (v === -1) continue;
			seen++;
			acc = (acc << 6) | v;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				emit((acc >> bits) & 0xff);
				acc &= (1 << bits) - 1;
			}
		}
		return;
	}
	if (enc === 'quoted-printable') {
		eachQuotedPrintable(raw, body, emit);
		return;
	}
	eachNormalized(raw, body, emit);
}

/** The decoded size of a located body, counted without allocating it. */
export function decodedLength(
	raw: Uint8Array,
	body: LocatedBody,
	encoding: string | undefined
): number {
	const enc = (encoding ?? '7bit').toLowerCase().trim();
	if (enc === 'base64') {
		const sextets = base64Sextets(raw, body);
		return sextets <= 0 ? 0 : Math.floor((sextets * 6) / 8);
	}
	let length = 0;
	eachDecoded(raw, body, encoding, () => {
		length++;
	});
	return length;
}

/**
 * Decode a located body into a byte array of exactly `length` bytes (from
 * {@link decodedLength}), byte for byte what `transferDecode` returns for the
 * same body (8-bit content aside, see the module comment).
 */
export function decodeLocated(
	raw: Uint8Array,
	body: LocatedBody,
	encoding: string | undefined,
	length: number
): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	let at = 0;
	eachDecoded(raw, body, encoding, (byte) => {
		if (at < length) out[at++] = byte;
	});
	return out;
}
