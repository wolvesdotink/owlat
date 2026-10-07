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
	isPostscriptLine,
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
import { insideContainer, type QuoteContainer, type SourceLine } from './mailSegmentsSource';

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
	| 'embedded_attribution'
	/**
	 * Unmarked text inside a quote container (Gmail's `gmail_quote`): an
	 * inline answer, or old text the container quotes without a blockquote.
	 */
	| 'unmarked_text_in_quote_container';

export interface Region {
	id: number;
	kind: SegmentKind;
	origin?: QuoteOrigin;
	/** An unmarked region opened inside a quote container ends with it. */
	container?: QuoteContainer;
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
	 * What the message's own subject says it is. Outlook writes the same header
	 * block for a reply and a forward and keeps the ORIGINAL subject in it, so
	 * the outer subject decides the first header block under the fresh text: a
	 * forward (`FW:`) makes it forwarded, a reply (`RE:`, also `RE: FW:`) makes
	 * it quoted whatever the embedded subject says. Only without either does
	 * the embedded subject decide.
	 */
	subjectKind?: 'forward' | 'reply' | 'other';
}

/**
 * Lines in a run of same-depth text squeezed between deeper quote lines with
 * no blank line on either side: wrapped quote text or an inline answer, which
 * the markers cannot tell apart (capitalisation proves nothing).
 */
function sandwichedLines(lines: SourceLine[]): boolean[] {
	const out = lines.map(() => false);
	let k = 0;
	while (k < lines.length) {
		const first = lines[k] as SourceLine;
		if (first.text === '') {
			k++;
			continue;
		}
		let e = k;
		while (
			e + 1 < lines.length &&
			lines[e + 1]?.text !== '' &&
			lines[e + 1]?.depth === first.depth
		) {
			e++;
		}
		const before = lines[k - 1];
		const after = lines[e + 1];
		if (before?.text && after?.text && before.depth > first.depth && after.depth > first.depth) {
			for (let j = k; j <= e; j++) out[j] = true;
		}
		k = e + 1;
	}
	return out;
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
	const sandwiched = sandwichedLines(lines);

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
		if (!marked) {
			penalty += 0.05;
			const holder = (lines[i] as SourceLine).container;
			if (holder) region.container = holder;
		}
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
		// An unmarked region opened inside a quote container ends with it.
		const bound = ctx.get(line.depth);
		if (bound?.container && !insideContainer(line, bound.container)) {
			if (line.depth === 0) ctx.set(0, open('fresh'));
			else ctx.delete(line.depth);
		}
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
			const outer = first ? options.subjectKind : undefined;
			const forwarded =
				outer === 'forward' ||
				(outer !== 'reply' && fields.subject !== undefined && isForwardSubject(fields.subject));
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
			if (sandwiched[i]) reasons.add('ambiguous_inline_reply');
			if (line.container) reasons.add('unmarked_text_in_quote_container');
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
		if (tail.signature < tail.signatureEnd) {
			const signature = open('signature');
			for (let k = tail.signature; k < tail.signatureEnd; k++) {
				regionOf[run[k] as number] = signature;
			}
		}
		if (tail.signatureEnd < tail.disclaimer && tail.signature < tail.signatureEnd) {
			// A postscript after the signature is message text again.
			const postscript = open('fresh');
			for (let k = tail.signatureEnd; k < tail.disclaimer; k++) {
				regionOf[run[k] as number] = postscript;
			}
		}
		if (tail.disclaimer < run.length) {
			const disclaimer = open('disclaimer');
			for (let k = tail.disclaimer; k < run.length; k++) regionOf[run[k] as number] = disclaimer;
		}
	}
	return penalty;
}

/**
 * Where a fresh run's signature and disclaimer lie (indices into `texts`, the
 * run's non-blank lines). The signature is `[signature, signatureEnd)`; lines
 * from `signatureEnd` to `disclaimer` are a postscript and stay fresh; the
 * disclaimer runs from `disclaimer` to the end. `breaks[k]` says a new
 * paragraph starts at line `k`. Conservative:
 *   - confidentiality notices count from the end, a whole paragraph at a time,
 *     and never the first paragraph;
 *   - a signature starts at the `-- ` delimiter, at a trailing "Sent from my
 *     phone" line, or at a closing ("Best regards,") that is not the first line
 *     and is followed only by a name block: names, companies, roles, contact
 *     and address lines (`isNameBlockLine`), never a request or a question;
 *   - a postscript (`P.S.`) after the signature ends it;
 *   - company legal lines at the end of a signature join the disclaimer.
 */
function splitFreshTail(
	texts: string[],
	breaks: boolean[]
): { signature: number; signatureEnd: number; disclaimer: number; byClosing: boolean } {
	let disclaimer = texts.length;
	for (;;) {
		let start = disclaimer - 1;
		while (start > 0 && !breaks[start]) start--;
		if (start <= 0) break;
		if (!isConfidentialityNotice(texts.slice(start, disclaimer).join(' '))) break;
		disclaimer = start;
	}

	/** The signature start within `[0, end)`, or -1. */
	const signatureIn = (end: number): { at: number; byClosing: boolean } => {
		const delimiter = texts.findIndex((t, k) => k < end && isSignatureDelimiter(t));
		if (delimiter >= 0) return { at: delimiter, byClosing: false };
		if (end > 1 && isMobileSignature(texts[end - 1] as string)) {
			return { at: end - 1, byClosing: false };
		}
		for (let c = end - 2; c >= 1 && c >= end - 9; c--) {
			if (!isClosingLine(texts[c] as string)) continue;
			if (texts.slice(c + 1, end).every(isNameBlockLine)) return { at: c, byClosing: true };
			break;
		}
		return { at: -1, byClosing: false };
	};

	const postscript = texts.findIndex((t, k) => k > 0 && k < disclaimer && isPostscriptLine(t));
	let found = postscript > 0 ? signatureIn(postscript) : { at: -1, byClosing: false };
	let signatureEnd = postscript;
	if (found.at < 0) {
		found = signatureIn(disclaimer);
		signatureEnd = disclaimer;
	}
	if (found.at < 0) {
		return { signature: disclaimer, signatureEnd: disclaimer, disclaimer, byClosing: false };
	}
	if (signatureEnd === disclaimer) {
		while (disclaimer > found.at + 1 && isLegalFooterLine(texts[disclaimer - 1] as string)) {
			disclaimer--;
		}
		signatureEnd = disclaimer;
	}
	return { signature: found.at, signatureEnd, disclaimer, byClosing: found.byClosing };
}
