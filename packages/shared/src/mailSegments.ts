/**
 * Attributed segments of one email body: the sender's own fresh text, quoted
 * history, forwarded messages, signature and disclaimer, each with who wrote
 * it where the message says so. Interpretation reads a message through this
 * (the model sees segment ids and quotes against them), and the reader maps a
 * cited quote back to the body through `sourceMap`.
 *
 * Pure string logic with no DOM, so it runs in the browser, in Convex V8
 * functions and in Node. Patterns are shared with `./quotedText` (the
 * composer's fresh/quoted split); the line model and its HTML rules are in
 * `./mailSegmentsSource`, the markers in `./mailSegmentsMarkers` and the
 * region rules in `./mailSegmentsClassify`.
 *
 * Guarantees:
 *   - `start`/`end` index into `canonicalText`, trimmed to the segment's first
 *     and last visible character; blank lines between segments belong to none.
 *   - The same input always gives the same segments and ids (`s0`, `s1`, … in
 *     reading order).
 *   - `uncertain` is true whenever the structure allows two readings
 *     (`uncertainReasons` says which); the segments then hold the reading that
 *     keeps more text fresh, and the caller must treat the message as not fully
 *     understood rather than trust either reading.
 */

import { classifyLines, type SegmentKind, type UncertainReason } from './mailSegmentsClassify';
import { subjectKindOf, type SegmentAuthor } from './mailSegmentsMarkers';
import {
	type LineSourceOptions,
	type SourceLine,
	type SourceRun,
	linesFromText,
	squeezeBlankLines,
} from './mailSegmentsSource';
import { linesFromHtml } from './mailSegmentsHtml';

export type { SegmentAuthor } from './mailSegmentsMarkers';
export type { SegmentKind, UncertainReason } from './mailSegmentsClassify';
export type { SourceRun } from './mailSegmentsSource';

export interface MailSegment {
	/** `s0`, `s1`, … in reading order. */
	id: string;
	kind: SegmentKind;
	/** The quoted or forwarded message's sender, when the message names one. */
	author?: SegmentAuthor;
	/** Its date as the message writes it (unparsed). */
	sentAt?: string;
	start: number;
	end: number;
}

/**
 * Canonical offsets back to the body they came from. Each run maps
 * `canonicalText[start, end)` to `source[srcStart, srcEnd)`: character for
 * character when both have the same length, otherwise as a whole (an entity, a
 * collapsed run of whitespace, a tag that became a line break).
 */
export interface SegmentSourceMap {
	source: 'text' | 'html';
	runs: SourceRun[];
}

export interface SegmentedMessage {
	canonicalText: string;
	segments: MailSegment[];
	sourceMap: SegmentSourceMap;
	/** 0–1: 1 when every boundary came from an explicit marker. */
	confidence: number;
	uncertain: boolean;
	uncertainReasons: UncertainReason[];
}

export interface SegmentMessageInput {
	text?: string | null;
	html?: string | null;
	/**
	 * The message subject. Its prefix decides an Outlook header block: `FW:` makes
	 * it forwarded, `RE:` (also `RE: FW:`) quoted, whatever the block's own subject says.
	 */
	subject?: string | null;
}

/**
 * Segment one message body. The HTML body is read when there is one (it is
 * what the reader shows), the text body otherwise.
 */
export function segmentMessage(
	input: SegmentMessageInput,
	options: LineSourceOptions = {}
): SegmentedMessage {
	const html = input.html ?? '';
	const source: 'text' | 'html' = html.trim() ? 'html' : 'text';
	const raw = source === 'html' ? linesFromHtml(html, options) : linesFromText(input.text ?? '');
	const lines = squeezeBlankLines(raw);
	const { canonicalText, lineStarts, runs } = assemble(lines);
	const { regionOf, reasons, penalty } = classifyLines(lines, {
		subjectKind: subjectKindOf(input.subject),
	});

	const segments: MailSegment[] = [];
	let current: { regionId: number; first: number; last: number } | null = null;
	const flush = () => {
		if (!current) return;
		const region = regionOf[current.first];
		if (!region) return;
		const firstLine = lines[current.first] as SourceLine;
		const lastLine = lines[current.last] as SourceLine;
		const lead = firstLine.text.length - firstLine.text.trimStart().length;
		segments.push({
			id: `s${segments.length}`,
			kind: region.kind,
			...(region.origin?.author ? { author: region.origin.author } : {}),
			...(region.origin?.sentAt ? { sentAt: region.origin.sentAt } : {}),
			start: (lineStarts[current.first] as number) + lead,
			end: (lineStarts[current.last] as number) + lastLine.text.length,
		});
	};
	for (const [i, region] of regionOf.entries()) {
		if (!region) continue;
		if (current && current.regionId === region.id) {
			current.last = i;
			continue;
		}
		flush();
		current = { regionId: region.id, first: i, last: i };
	}
	flush();

	const uncertain = reasons.length > 0;
	const confidence = Math.max(0, Math.min(1, 1 - penalty - reasons.length * 0.3));
	return {
		canonicalText,
		segments,
		sourceMap: { source, runs },
		confidence: Math.round(confidence * 100) / 100,
		uncertain,
		uncertainReasons: reasons,
	};
}

function assemble(lines: SourceLine[]): {
	canonicalText: string;
	lineStarts: number[];
	runs: SourceRun[];
} {
	const parts: string[] = [];
	const lineStarts: number[] = [];
	const runs: SourceRun[] = [];
	let offset = 0;
	for (const [k, line] of lines.entries()) {
		if (k > 0) {
			const prev = lines[k - 1] as SourceLine;
			const lastRun = prev.runs[prev.runs.length - 1];
			const srcStart = lastRun ? lastRun.srcEnd : prev.srcEnd;
			const srcEnd = Math.max(srcStart, line.runs[0]?.srcStart ?? line.srcStart);
			runs.push({ start: offset, end: offset + 1, srcStart, srcEnd });
			parts.push('\n');
			offset++;
		}
		lineStarts.push(offset);
		for (const run of line.runs) {
			runs.push({ ...run, start: run.start + offset, end: run.end + offset });
		}
		parts.push(line.text);
		offset += line.text.length;
	}
	return { canonicalText: parts.join(''), lineStarts, runs };
}

/**
 * The source range behind `canonicalText[start, end)`, for highlighting a
 * cited quote in the body: null when the range is empty or outside the text.
 */
export function mapToSource(
	map: SegmentSourceMap,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (end <= start) return null;
	const first = findRun(map.runs, start);
	const last = findRun(map.runs, end - 1);
	if (!first || !last) return null;
	const at = (run: SourceRun, offset: number, edge: 'start' | 'end') => {
		if (run.end - run.start === run.srcEnd - run.srcStart) return run.srcStart + offset - run.start;
		return edge === 'start' ? run.srcStart : run.srcEnd;
	};
	return { start: at(first, start, 'start'), end: at(last, end, 'end') };
}

function findRun(runs: SourceRun[], offset: number): SourceRun | undefined {
	let lo = 0;
	let hi = runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const run = runs[mid] as SourceRun;
		if (offset < run.start) hi = mid - 1;
		else if (offset >= run.end) lo = mid + 1;
		else return run;
	}
	return undefined;
}
