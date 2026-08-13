import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Raw Tailwind palette classes must not come back into the dashboard.
 *
 * The app paints itself from the semantic tokens in
 * packages/ui/assets/css/tokens.css (`bg-bg-surface`, `text-text-secondary`,
 * `border-border-subtle`, …), which is what makes a light/dark switch a single
 * variable swap. A literal `bg-white` or `text-gray-500` opts one element out of
 * that switch, so it survives review as a local nicety and then shows up as a
 * blinding island the first time someone opens the page in the other theme.
 *
 * Sibling of `lint:env` (apps/api/scripts/check-env.sh): a seam oxlint cannot
 * express, so it is a script run as part of the lint gate.
 */

const workspace = join(import.meta.dirname, '..');
const root = join(workspace, 'apps', 'web', 'app');

/**
 * The banned classes, as whole utility tokens.
 *
 * `(?<![\w-])` lets the variant prefixes through (`hover:bg-white`,
 * `dark:text-gray-400`) while keeping a longer class that merely ends in one out
 * (`bg-bg-white` is not this token). The trailing `(?![\w-])` stops at the same
 * boundary but deliberately admits `/`, because `bg-white/10` and `text-white/70`
 * are the same opt-out with an opacity on it.
 */
const PALETTE = /(?<![\w-])(?:(?:bg|text)-white|(?:bg|text|border)-gray-\d+)(?![\w-])/g;

/**
 * TWO comment shapes, because the two jobs want opposite risk.
 *
 * MASK blanks comments so prose about `bg-white` is not read as markup. It takes
 * `//` only at the start of a line: a trailing `//` is indistinguishable from the
 * one inside `'https://cdn/x'`, and blanking the rest of THAT line would hide a
 * real class sitting after it — a false negative, the one direction a gate must
 * not fail in.
 *
 * SPAN finds the escape-hatch markers and so takes every `//`, trailing included:
 * over-reading here can only ever notice a marker, and `const c = 'bg-white'; //
 * palette-ok: …` is exactly how the hatch reads in a script block.
 */
const MASK = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm;
const SPAN = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const MARKER = /palette-ok(-start|-end)?/g;

/** How far a lone marker will follow a start tag looking for the line that closes it. */
const TAG_LINES = 40;

type Marker = {
	kind: 'line' | 'start' | 'end';
	/** 1-based line the marker word sits on. */
	line: number;
	/** 1-based lines the enclosing comment opens and closes on. */
	openLine: number;
	closeLine: number;
	/** Code precedes the comment on its opening line, so it annotates that line. */
	trailing: boolean;
	reason: string;
};

type Exemption = { marker: Marker; from: number; to: number; used: boolean };

async function sources(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			// A class name in a spec is never compiled into anything Tailwind
			// renders, and the assertions that pin these rules quote the banned
			// names by construction.
			if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
			if (/\.(?:test|spec)\.ts$/.test(entry.name)) return [];
			return /\.(?:vue|ts)$/.test(entry.name) ? [path] : [];
		})
	);
	return nested.flat();
}

/** Offsets at which each 1-based line begins, so a match maps to a location. */
function lineIndex(source: string): number[] {
	const starts = [0];
	for (let at = 0; at < source.length; at += 1) if (source[at] === '\n') starts.push(at + 1);
	return starts;
}

function lineOf(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if ((starts[mid] ?? 0) <= offset) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

function physicalLine(source: string, starts: number[], line: number): string {
	const start = starts[line - 1] ?? 0;
	const end = starts[line] ?? source.length + 1;
	return source.slice(start, end - 1);
}

/** Comments blanked to spaces — newlines kept, so every line still numbers the same. */
function masked(source: string): string {
	return source.replace(MASK, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * The lines a lone marker annotates: the next element, START TAG INCLUDED.
 *
 * A class attribute usually sits several lines inside a multi-line start tag,
 * and HTML forbids a comment in there — so "the next line" would put the hatch
 * out of reach of exactly the elements that need it most, and every one of them
 * would have to spend two lines on a region instead. The tag is followed to the
 * line that closes it, which the formatter always leaves as a bare `>` or `/>`.
 *
 * Intervening blank and comment-only lines are stepped over (they read as
 * whitespace once masked), so a marker can share a comment block with prose.
 */
function annotated(lines: string[], from: number): [number, number] {
	let start = from;
	while (start <= lines.length && (lines[start - 1] ?? '').trim() === '') start += 1;
	if (start > lines.length) return [from, from];
	const first = (lines[start - 1] ?? '').trim();
	if (!first.startsWith('<') || first.endsWith('>')) return [start, start];
	// Bounded: the longest start tag in this app is ~15 lines, and a runaway scan
	// would quietly exempt an unrelated element further down — the one thing an
	// escape hatch must never do.
	for (let line = start + 1; line <= Math.min(lines.length, start + TAG_LINES); line += 1) {
		const text = (lines[line - 1] ?? '').trim();
		if (text === '>' || text === '/>') return [start, line];
	}
	return [start, start];
}

/** The words after the marker on its own physical line, stripped of the comment's tail. */
function reasonOf(source: string, starts: number[], offset: number, length: number): string {
	const line = lineOf(starts, offset);
	const start = starts[line - 1] ?? 0;
	return physicalLine(source, starts, line)
		.slice(offset - start + length)
		.replace(/-->\s*$|\*\/\s*$/, '')
		.replace(/^\s*:\s*/, '')
		.trim();
}

function markersIn(source: string, starts: number[]): Marker[] {
	const markers: Marker[] = [];
	for (const span of source.matchAll(SPAN)) {
		const text = span[0];
		const openLine = lineOf(starts, span.index);
		const closeLine = lineOf(starts, span.index + text.length - 1);
		const before = source.slice(starts[openLine - 1] ?? 0, span.index);
		for (const hit of text.matchAll(MARKER)) {
			const offset = span.index + hit.index;
			markers.push({
				kind: hit[1] === '-start' ? 'start' : hit[1] === '-end' ? 'end' : 'line',
				line: lineOf(starts, offset),
				openLine,
				closeLine,
				trailing: before.trim().length > 0,
				reason: reasonOf(source, starts, offset, hit[0].length),
			});
		}
	}
	return markers;
}

/**
 * Marker → the lines it excuses, plus the ways the pairing can be malformed.
 *
 * A lone `palette-ok` annotates ONE element: the line it trails, or — when it
 * has a line to itself — the element right below it, start tag and all. The
 * `-start`/`-end` pair exists for the wider case a single element cannot state:
 * a whole surface painted on a fixed backdrop, where every colour under it is
 * literal for the same one reason.
 */
function resolve(
	markers: Marker[],
	lines: string[]
): { exemptions: Exemption[]; malformed: string[] } {
	const exemptions: Exemption[] = [];
	const malformed: string[] = [];
	let open: Marker | null = null;
	for (const marker of markers) {
		if (marker.kind === 'end') {
			if (!open) malformed.push(`${marker.line}: palette-ok-end without a palette-ok-start`);
			else exemptions.push({ marker: open, from: open.line, to: marker.line, used: false });
			open = null;
			continue;
		}
		if (marker.reason.length === 0) {
			malformed.push(`${marker.line}: palette-ok needs a reason after the colon`);
			continue;
		}
		if (marker.kind === 'start') {
			if (open) malformed.push(`${marker.line}: palette-ok-start inside an unclosed region`);
			open = marker;
			continue;
		}
		const [from, to] = marker.trailing
			? [marker.openLine, marker.openLine]
			: annotated(lines, marker.closeLine + 1);
		exemptions.push({ marker, from, to, used: false });
	}
	if (open) malformed.push(`${open.line}: palette-ok-start is never closed by a palette-ok-end`);
	return { exemptions, malformed };
}

const files = await sources(root).catch((error: unknown) => {
	// A root that moved must be a build failure, not an empty scan that keeps
	// reporting a clean surface it never read.
	console.error(`Cannot scan ${relative(workspace, root)}: ${String(error)}`);
	process.exit(1);
});

const violations: string[] = [];
const unused: string[] = [];
for (const file of files) {
	const source = await readFile(file, 'utf8');
	const name = relative(workspace, file);
	const starts = lineIndex(source);
	const visible = masked(source);
	const { exemptions, malformed } = resolve(markersIn(source, starts), visible.split('\n'));
	violations.push(...malformed.map((entry) => `${name}:${entry}`));
	for (const hit of visible.matchAll(PALETTE)) {
		const line = lineOf(starts, hit.index);
		const exemption = exemptions.find((entry) => line >= entry.from && line <= entry.to);
		if (exemption) exemption.used = true;
		else violations.push(`${name}:${line}: ${hit[0]}`);
	}
	unused.push(
		...exemptions.filter((entry) => !entry.used).map((entry) => `${name}:${entry.marker.line}`)
	);
}

if (violations.length > 0) {
	console.error(
		'Raw palette classes in apps/web/app — these opt out of the light/dark token swap. Use the semantic tokens (bg-bg-surface, text-text-secondary, border-border-subtle, …):'
	);
	console.error(violations.join('\n'));
	console.error(
		'\nWhen the literal colour IS the point — email paper that ships its own light palette, chrome drawn on a fixed scrim — say so inline. One marker covers the element below it, start tag and all:\n' +
			'  <!-- palette-ok: why a token would be wrong here -->\n' +
			'  <iframe\n' +
			'    class="bg-white"\n' +
			'  />\n' +
			'and a whole surface that is literal for one reason takes a region:\n' +
			'  <!-- palette-ok-start: why a token would be wrong here -->\n' +
			'  …\n' +
			'  <!-- palette-ok-end -->'
	);
}

// Reported ALONGSIDE the violations, not instead of them: both verdicts come out
// of the same scan and are independent edits. An exemption whose element has
// since been re-tokenised excuses nothing today and silently pre-approves the
// regression that puts the palette class back tomorrow.
if (unused.length > 0) {
	console.error(
		'\nUnused palette-ok exemption — no raw palette class in the lines it covers, so it only widens what can regress. Delete the marker:'
	);
	console.error(unused.join('\n'));
}

if (violations.length > 0 || unused.length > 0) process.exit(1);
