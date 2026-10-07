/**
 * The HTML tree builder's list of active formatting elements, as the security
 * scan's hidden-markup strip (`hiddenMarkup.ts`) follows it. A formatting
 * element (`<b>`, `<font>`, `<a>`, …) that something other than its own end tag
 * closes stays on this list, and the browser reopens it before the next text
 * or inline element, so a hidden one keeps hiding what follows. Cells,
 * captions, templates and `applet`/`marquee`/`object` add markers that bound
 * which entries are reopened.
 *
 * Bounded: each stretch of the list after a marker keeps at most
 * {@link MAX_ENTRIES} live entries. Dropping a hidden one to stay under that
 * bound sets {@link ActiveFormatting.overflowed}, and the strip then hides to
 * the end of the input rather than lose track of it. Every operation walks only
 * the last stretch, so the cost per operation is constant. A meter, when given,
 * counts the entries the walks visit (see `ScanMeter` in hiddenMarkup.ts).
 */

/** One formatting element on the list. */
export interface FormattingEntry {
	readonly name: string;
	readonly hides: boolean;
	/** On the stack of open elements (as opposed to closed and waiting to reopen). */
	open: boolean;
	/** Still on the list. */
	listed: boolean;
	/** Which stretch between markers it was added to. */
	readonly stretch: number;
}

/** A marker on the list. */
const MARKER = null;

/** Live entries kept after the last marker. */
const MAX_ENTRIES = 16;

export class ActiveFormatting {
	private entries: Array<FormattingEntry | typeof MARKER> = [];
	/** Where the last stretch (after the last marker) starts in `entries`. */
	private stretchStart = 0;
	/** The last stretch's id, and the ids of the stretches below it. */
	private stretch = 0;
	private readonly stretchesBelow: number[] = [];
	private nextStretch = 1;
	/** Live entries in the last stretch. */
	private liveInStretch = 0;
	/** Closed hidden entries on the list: while any is left, hiding continues. */
	hiddenClosed = 0;
	/** A hidden entry was dropped to respect the bound. */
	overflowed = false;

	constructor(private readonly meter?: { steps: number }) {}

	/** Add an open formatting element. */
	add(name: string, hides: boolean): FormattingEntry {
		const entry: FormattingEntry = { name, hides, open: true, listed: true, stretch: this.stretch };
		this.entries.push(entry);
		this.liveInStretch++;
		if (this.liveInStretch > MAX_ENTRIES) this.dropOldest();
		if (this.entries.length - this.stretchStart > 4 * MAX_ENTRIES) this.compactStretch();
		return entry;
	}

	addMarker(): void {
		this.entries.push(MARKER);
		this.stretchesBelow.push(this.stretch);
		this.stretch = this.nextStretch++;
		this.stretchStart = this.entries.length;
		this.liveInStretch = 0;
	}

	/** Remove every entry after the last marker, and the marker. */
	clearToMarker(): void {
		while (this.entries.length > 0) {
			this.visit();
			const entry = this.entries.pop();
			if (entry === MARKER || entry === undefined) break;
			this.unlist(entry);
		}
		this.stretch = this.stretchesBelow.pop() ?? 0;
		this.stretchStart = this.entries.length;
		this.liveInStretch = 0;
		while (this.stretchStart > 0 && this.entries[this.stretchStart - 1] !== MARKER) {
			this.visit();
			this.stretchStart--;
			if (this.entries[this.stretchStart]?.listed) this.liveInStretch++;
		}
	}

	/** An open entry was closed by something other than its end tag. */
	closed(entry: FormattingEntry): void {
		if (!entry.listed || !entry.open) return;
		entry.open = false;
		if (entry.hides) this.hiddenClosed++;
	}

	/** Take an entry off the list: its own end tag closed it, or it left the tree. */
	remove(entry: FormattingEntry): void {
		if (!entry.listed) return;
		this.unlist(entry);
		// Drop removed entries from the end, so the last stretch stays short.
		while (this.entries.length > this.stretchStart) {
			const last = this.entries[this.entries.length - 1];
			if (last === MARKER || last === undefined || last.listed) break;
			this.entries.pop();
			this.visit();
		}
	}

	/** The newest live entry named `name` after the last marker, or null. */
	lastAfterMarker(name: string): FormattingEntry | null {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			this.visit();
			const entry = this.entries[i];
			if (entry === MARKER || entry === undefined) return null;
			if (entry.listed && entry.name === name) return entry;
		}
		return null;
	}

	/**
	 * The closed entries the browser reopens before new content, oldest first:
	 * none when the newest live entry is open or a marker, otherwise every closed
	 * entry back to the nearest open one or marker. They are marked open.
	 */
	reopen(): FormattingEntry[] {
		let i = this.entries.length - 1;
		while (i >= 0 && this.entries[i] !== MARKER && !this.entries[i]?.listed) {
			this.visit();
			i--;
		}
		const newest = this.entries[i];
		if (i < 0 || newest === MARKER || newest === undefined || newest.open) return [];
		let first = i;
		for (let j = i - 1; j >= 0; j--) {
			this.visit();
			const entry = this.entries[j];
			if (entry === MARKER || entry === undefined) break;
			if (!entry.listed) continue;
			if (entry.open) break;
			first = j;
		}
		const reopened: FormattingEntry[] = [];
		for (let j = first; j <= i; j++) {
			this.visit();
			const entry = this.entries[j];
			if (entry === MARKER || entry === undefined || !entry.listed) continue;
			entry.open = true;
			if (entry.hides) this.hiddenClosed--;
			reopened.push(entry);
		}
		return reopened;
	}

	/** Count one entry visited, for the meter. */
	private visit(): void {
		if (this.meter) this.meter.steps++;
	}

	private unlist(entry: FormattingEntry): void {
		if (!entry.listed) return;
		entry.listed = false;
		if (!entry.open && entry.hides) this.hiddenClosed--;
		if (entry.stretch === this.stretch) this.liveInStretch--;
	}

	/** Drop the oldest live entry after the last marker. */
	private dropOldest(): void {
		for (let i = this.stretchStart; i < this.entries.length; i++) {
			this.visit();
			const entry = this.entries[i];
			if (entry === MARKER || entry === undefined || !entry.listed) continue;
			if (entry.hides) this.overflowed = true;
			this.unlist(entry);
			return;
		}
	}

	/** Remove unlisted entries from the last stretch. */
	private compactStretch(): void {
		const kept = this.entries.slice(this.stretchStart).filter((entry) => {
			this.visit();
			return entry?.listed;
		});
		this.entries.length = this.stretchStart;
		for (const entry of kept) this.entries.push(entry);
	}
}
