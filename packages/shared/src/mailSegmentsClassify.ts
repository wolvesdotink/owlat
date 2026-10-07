/**
 * Region classification for `segmentMessage` (`./mailSegments`): which lines
 * of a message are its own fresh text, quoted history, a forwarded message, a
 * signature or a disclaimer, and who wrote the quoted or forwarded parts.
 *
 * Lines carry a depth (blockquote nesting plus `>` markers). A region is opened
 * by an explicit marker and holds lines at one depth:
 *   - an attribution ("On … wrote:") or forward banner followed by DEEPER lines
 *     opens a MARKED region one level down: it ends where the depth drops, and
 *     whatever follows at the outer depth is fresh again (an inline reply);
 *   - an attribution, banner or Outlook header block followed by lines at the
 *     SAME depth opens an UNMARKED region that runs until the depth drops below
 *     it, because nothing marks where the old message ends;
 *   - deeper lines with no marker are a quote with no named author (inline
 *     replies reuse the author named for the first quote at that depth).
 * Fresh text then loses a trailing confidentiality notice, signature and
 * company legal footer (see {@link splitFreshTail}).
 *
 * Whenever the structure allows two readings, a reason is recorded and the
 * caller reports the message as uncertain rather than picking one silently.
 */

import {
	type QuoteOrigin,
	isAttributionLine,
	isClosingLine,
	isConfidentialityNotice,
	isForwardBanner,
	isForwardSubject,
	isLegalFooterLine,
	isMobileSignature,
	isNameBlockLine,
	isOriginalMessageLine,
	isSeparatorLine,
	isSignatureDelimiter,
	isWrappedAttribution,
	hasEmbeddedAttribution,
	parseAddress,
	parseAttribution,
	parseHeaderLine,
	type HeaderField,
} from './mailSegmentsMarkers';
import type { SourceLine } from './mailSegmentsSource';

export type SegmentKind = 'fresh' | 'quoted' | 'forwarded' | 'signature' | 'disclaimer';

/** Why a message's segmentation is uncertain. */
export type UncertainReason =
	/** A line inside a quote may be a wrapped quote line or an inline answer. */
	| 'ambiguous_inline_reply'
	/** A forwarded message whose original sender could not be read. */
	| 'forward_without_author'
	/** An Outlook reply header the parser could not read. */
	| 'unparsed_quote_header'
	/** A quote container that is neither clearly a reply nor a forward. */
	| 'ambiguous_quote_container'
	/** An attribution run into other text, so the quote boundary is unknown. */
	| 'embedded_attribution';

export interface Region {
	id: number;
	kind: SegmentKind;
	origin?: QuoteOrigin;
}

export interface Classification {
	/** The region of each line; null for blank lines. */
	regionOf: (Region | null)[];
	reasons: UncertainReason[];
	/** Confidence lost to heuristics that are not reasons for doubt on their own. */
	penalty: number;
}

interface HeaderBlock {
	end: number;
	fields: Partial<Record<HeaderField, string>>;
}

/** `Label: value` lines from `start` (blank lines before the first one skipped). */
function readHeaderBlock(lines: SourceLine[], start: number): HeaderBlock | null {
	let j = start;
	while (j < lines.length && j < start + 2 && lines[j]?.text === '') j++;
	const fields: Partial<Record<HeaderField, string>> = {};
	let count = 0;
	const depth = lines[j]?.depth;
	for (; j < lines.length && count < 12; j++) {
		const line = lines[j] as SourceLine;
		if (line.depth !== depth) break;
		const header = parseHeaderLine(line.text);
		if (!header) break;
		fields[header.field] ??= header.value;
		count++;
	}
	return count > 0 ? { end: j, fields } : null;
}

function originOf(fields: Partial<Record<HeaderField, string>>): QuoteOrigin {
	const author = fields.from ? parseAddress(fields.from) : undefined;
	return { ...(author ? { author } : {}), ...(fields.date ? { sentAt: fields.date } : {}) };
}

function nextNonBlank(lines: SourceLine[], from: number): number {
	for (let j = from; j < lines.length; j++) if (lines[j]?.text !== '') return j;
	return -1;
}

export interface ClassifyOptions {
	/**
	 * The message's own subject is a forward (`FW:`). Outlook writes the same
	 * header block for a reply and a forward, and keeps the ORIGINAL subject in
	 * it, so only the outer subject tells them apart: the first header block
	 * under the fresh text is then the forwarded message.
	 */
	forwardedSubject?: boolean;
}

export function classifyLines(lines: SourceLine[], options: ClassifyOptions = {}): Classification {
	const regionOf: (Region | null)[] = lines.map(() => null);
	const reasons = new Set<UncertainReason>();
	let penalty = 0;
	let nextId = 0;
	const open = (kind: SegmentKind, origin?: QuoteOrigin): Region => ({
		id: nextId++,
		kind,
		...(origin && (origin.author || origin.sentAt) ? { origin } : {}),
	});
	const ctx = new Map<number, Region>([[0, open('fresh')]]);
	const firstOrigin = new Map<number, QuoteOrigin>();
	let lastRegion: Region | null = null;
	let headerSeen = false;

	const claim = (from: number, to: number, region: Region) => {
		for (let k = from; k < to; k++) if (lines[k]?.text !== '') regionOf[k] = region;
	};
	/** Open a region at `line`: one level down if the next content is deeper. */
	const startRegion = (i: number, after: number, kind: SegmentKind, origin: QuoteOrigin) => {
		const depth = (lines[i] as SourceLine).depth;
		const region = open(kind, origin);
		const next = nextNonBlank(lines, after);
		const marked = next >= 0 && (lines[next] as SourceLine).depth > depth;
		ctx.set(marked ? depth + 1 : depth, region);
		if (marked && region.origin && !firstOrigin.has(depth + 1)) {
			firstOrigin.set(depth + 1, region.origin);
		}
		if (!marked) penalty += 0.05;
		claim(i, after, region);
		return { region, marked };
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as SourceLine;
		if (line.text === '') continue;
		// Lines a marker already claimed (its header block, a wrapped attribution)
		// leave the open regions alone: the region they opened may sit deeper.
		if (regionOf[i]) {
			lastRegion = regionOf[i] as Region;
			continue;
		}
		for (const depth of ctx.keys()) if (depth > line.depth) ctx.delete(depth);
		const text = line.text.trim();
		const nextLine = lines[i + 1];

		if (isForwardBanner(text) || line.hint === 'forwardContainer') {
			const header = readHeaderBlock(lines, i + 1);
			const origin = header ? originOf(header.fields) : {};
			const { region } = startRegion(i, header?.end ?? i + 1, 'forwarded', origin);
			if (!origin.author) reasons.add('forward_without_author');
			lastRegion = region;
			continue;
		}

		const lead = isSeparatorLine(text) || isOriginalMessageLine(text);
		const header = readHeaderBlock(lines, lead ? i + 1 : i);
		const isHeader = !!header && !!header.fields.from && !!header.fields.date;
		if (
			isHeader ||
			isOriginalMessageLine(text) ||
			(line.hint === 'outlookHeader' && (!!header || !lead))
		) {
			const fields = header?.fields ?? {};
			const first = !headerSeen && line.depth === 0;
			headerSeen = true;
			const forwarded =
				(fields.subject !== undefined && isForwardSubject(fields.subject)) ||
				(first && options.forwardedSubject === true);
			const kind = forwarded ? 'forwarded' : 'quoted';
			const after = header && (isHeader || line.hint === 'outlookHeader') ? header.end : i + 1;
			const { region } = startRegion(i, after, kind, originOf(fields));
			if (line.hint === 'outlookHeader' && !fields.from) reasons.add('unparsed_quote_header');
			if (kind === 'forwarded' && !region.origin?.author) reasons.add('forward_without_author');
			lastRegion = region;
			continue;
		}

		const wrapped =
			!!nextLine && nextLine.depth === line.depth && isWrappedAttribution(text, nextLine.text);
		if (isAttributionLine(text) || wrapped) {
			const origin = parseAttribution(wrapped ? `${text} ${nextLine?.text.trim()}` : text);
			const { region } = startRegion(i, wrapped ? i + 2 : i + 1, 'quoted', origin);
			lastRegion = region;
			continue;
		}

		if (line.hint === 'quoteContainer') {
			const { region, marked } = startRegion(i, i + 1, 'quoted', {});
			if (!marked) reasons.add('ambiguous_quote_container');
			lastRegion = region;
			continue;
		}

		let region = ctx.get(line.depth);
		if (!region) {
			region = open('quoted', firstOrigin.get(line.depth));
			ctx.set(line.depth, region);
		} else if (region.kind === 'fresh' && lastRegion && lastRegion !== region) {
			region = open('fresh');
			ctx.set(line.depth, region);
		}
		if (region.kind === 'fresh') {
			const prev = lines[i - 1];
			const after = lines[i + 1];
			if (
				prev &&
				after &&
				prev.text !== '' &&
				prev.depth > line.depth &&
				after.depth === prev.depth &&
				after.text !== '' &&
				/^\p{Ll}/u.test(text) &&
				!/[.?!:;]$/.test(prev.text.trim())
			) {
				reasons.add('ambiguous_inline_reply');
			}
			if (hasEmbeddedAttribution(text)) reasons.add('embedded_attribution');
		}
		regionOf[i] = region;
		lastRegion = region;
	}

	penalty += splitFreshTails(lines, regionOf, open);
	return { regionOf, reasons: [...reasons], penalty };
}

/** Indices of the lines of each fresh region, in order. */
function freshRuns(regionOf: (Region | null)[]): number[][] {
	const runs = new Map<number, number[]>();
	for (const [i, region] of regionOf.entries()) {
		if (region?.kind !== 'fresh') continue;
		const run = runs.get(region.id) ?? [];
		run.push(i);
		runs.set(region.id, run);
	}
	return [...runs.values()];
}

function splitFreshTails(
	lines: SourceLine[],
	regionOf: (Region | null)[],
	open: (kind: SegmentKind) => Region
): number {
	let penalty = 0;
	for (const run of freshRuns(regionOf)) {
		const texts = run.map((i) => (lines[i] as SourceLine).text);
		// A gap in the line numbers is a blank line (or another region) between.
		const breaks = run.map((i, k) => k === 0 || i !== (run[k - 1] as number) + 1);
		const tail = splitFreshTail(texts, breaks);
		if (tail.byClosing) penalty += 0.05;
		if (tail.signature < tail.disclaimer) {
			const signature = open('signature');
			for (let k = tail.signature; k < tail.disclaimer; k++) regionOf[run[k] as number] = signature;
		}
		if (tail.disclaimer < run.length) {
			const disclaimer = open('disclaimer');
			for (let k = tail.disclaimer; k < run.length; k++) regionOf[run[k] as number] = disclaimer;
		}
	}
	return penalty;
}

/**
 * Where a fresh run's signature and disclaimer start (indices into `texts`, the
 * run's non-blank lines; `texts.length` when there is none). `breaks[k]` says a
 * new paragraph starts at line `k`. Conservative:
 *   - confidentiality notices count from the end, a whole paragraph at a time,
 *     and never the first paragraph;
 *   - a signature starts at the `-- ` delimiter, at a trailing "Sent from my
 *     phone" line, or at a closing ("Best regards,") that is not the first line
 *     and is followed only by a short name block;
 *   - company legal lines at the end of a signature join the disclaimer.
 */
function splitFreshTail(
	texts: string[],
	breaks: boolean[]
): { signature: number; disclaimer: number; byClosing: boolean } {
	let disclaimer = texts.length;
	for (;;) {
		let start = disclaimer - 1;
		while (start > 0 && !breaks[start]) start--;
		if (start <= 0) break;
		if (!isConfidentialityNotice(texts.slice(start, disclaimer).join(' '))) break;
		disclaimer = start;
	}

	let signature = texts.length;
	let byClosing = false;
	const delimiter = texts.findIndex((t, k) => k < disclaimer && isSignatureDelimiter(t));
	if (delimiter >= 0) {
		signature = delimiter;
	} else if (disclaimer > 1 && isMobileSignature(texts[disclaimer - 1] as string)) {
		signature = disclaimer - 1;
	} else {
		for (let c = disclaimer - 2; c >= 1 && c >= disclaimer - 9; c--) {
			if (!isClosingLine(texts[c] as string)) continue;
			if (texts.slice(c + 1, disclaimer).every(isNameBlockLine)) {
				signature = c;
				byClosing = true;
			}
			break;
		}
	}
	if (signature < disclaimer) {
		while (disclaimer > signature + 1 && isLegalFooterLine(texts[disclaimer - 1] as string)) {
			disclaimer--;
		}
	}
	return { signature: Math.min(signature, disclaimer), disclaimer, byClosing };
}
