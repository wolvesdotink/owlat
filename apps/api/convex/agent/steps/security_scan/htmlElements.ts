/**
 * The HTML element categories and the stack of open elements the security
 * scan's hidden-markup strip (`hiddenMarkup.ts`) follows. The categories are the
 * ones the HTML tree builder uses to decide which end tag closes what, which
 * start tag closes an open element implicitly, and where SVG and MathML content
 * ends. The stack keeps per-name and per-category indexes, so each of those
 * decisions takes constant time (amortised over the pops it causes).
 */

import type { FormattingEntry } from './activeFormatting';

/** A set of element names from a whitespace-separated list. */
const elementNames = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

/** Elements that never have content or an end tag. */
export const VOID_ELEMENTS = elementNames(`
	area base basefont bgsound br col embed frame hr img input keygen link meta
	param source track wbr
`);

/** Elements whose content is text up to their own end tag, never markup. */
export const RAW_TEXT_ELEMENTS = elementNames(`
	iframe noembed noframes plaintext script style textarea title xmp
`);

/**
 * Elements the browser never shows, whatever their style: their content is
 * inert (`template`), code (`script`, `style`) or hidden by the default style
 * sheet.
 */
export const ALWAYS_HIDDEN_ELEMENTS = elementNames(`
	datalist iframe noembed noframes rp script style template title
`);

/**
 * Start tags the browser ignores inside the body: the document already has its
 * `html`, `head` and `body` (their attributes are merged into the existing
 * elements), and `frameset` is only read before the body starts.
 */
export const IGNORED_START_TAGS = elementNames(`body frame frameset head html`);

/** Table parts, whose start tags the browser ignores unless a table is open. */
export const TABLE_PARTS = elementNames(`caption colgroup tbody td tfoot th thead tr`);

/**
 * Formatting elements: the browser reopens these after an ancestor's end tag
 * closes them (the "active formatting elements" list).
 */
export const FORMATTING_ELEMENTS = elementNames(`
	a b big code em font i nobr s small strike strong tt u
`);

/**
 * The HTML "special" elements, plus the MathML and SVG ones. The end tag of an
 * ordinary element (one not in this set) is ignored when a special element sits
 * above that element on the stack.
 */
const SPECIAL_ELEMENTS = elementNames(`
	address annotation-xml applet article aside blockquote body button caption
	center colgroup dd desc details dialog dir div dl dt fieldset figcaption
	figure footer foreignobject form frameset h1 h2 h3 h4 h5 h6 head header
	hgroup html iframe li listing main marquee menu mi mn mo ms mtext nav noembed
	noframes noscript object ol p plaintext pre search section select summary
	table tbody td template textarea tfoot th thead title tr ul xmp
`);

/**
 * The MathML and SVG members of the special category. Their end tags follow
 * the ordinary-element rule, not a scope rule.
 */
const FOREIGN_SPECIAL_ELEMENTS = elementNames(`
	annotation-xml desc foreignobject mi mn mo ms mtext
`);

/** The HTML default scope's boundaries, with its MathML and SVG members. */
const SCOPE_BOUNDARIES = elementNames(`
	annotation-xml applet caption desc foreignobject html marquee mi mn mo ms
	mtext object table td template th
`);

/** Table scope: what stops a table end tag, or a new cell or row, reaching further. */
const TABLE_SCOPE_BOUNDARIES = elementNames(`html table template`);

/** End tags matched within table scope rather than the default scope. */
const TABLE_SCOPED_END_TAGS = elementNames(`caption colgroup table tbody td tfoot th thead tr`);

const HEADINGS = elementNames(`h1 h2 h3 h4 h5 h6`);

/**
 * Elements whose end tag also clears the reopen list back to where they
 * started, so a formatting element inside one is not reopened after it.
 */
export const MARKER_ELEMENTS = elementNames(`applet caption marquee object td template th`);

/**
 * Start tags that close an open `<p>` (in button scope). `table` is left out:
 * mail is usually rendered in quirks mode, where a table opens inside the
 * paragraph.
 */
const CLOSES_PARAGRAPH = elementNames(`
	address article aside blockquote center dd details dialog dir div dl dt
	fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li
	listing main menu nav ol p plaintext pre search section summary ul xmp
`);

/** Where an element lives: HTML (`''`), SVG or MathML. */
export type Namespace = '' | 'svg' | 'math';

/** SVG and MathML elements whose content is read as HTML again. */
const INTEGRATION_POINTS: Record<Exclude<Namespace, ''>, ReadonlySet<string>> = {
	svg: elementNames(`desc foreignobject title`),
	math: elementNames(`annotation-xml mi mn mo ms mtext`),
};

const isIntegrationPoint = (namespace: Namespace, name: string): boolean =>
	namespace !== '' && INTEGRATION_POINTS[namespace].has(name);

/**
 * HTML start tags that end SVG or MathML content when they appear inside it.
 * `font` does so only with a colour, face or size attribute and is left out.
 */
const FOREIGN_BREAKOUT = elementNames(`
	b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6
	head hr i img li listing menu meta nobr ol p pre ruby s small span strike
	strong sub sup table tt u ul var
`);

/**
 * Special or void start tags before which the browser still reopens closed
 * formatting elements (`reconstruct the active formatting elements`). Every
 * other element outside the special category does too.
 */
const RECONSTRUCTING_SPECIALS = elementNames(`
	applet area br button embed img image input keygen marquee object select wbr xmp
`);

/** Start tags outside the special category that do not reopen formatting elements. */
const NON_RECONSTRUCTING = elementNames(`
	base basefont bgsound col frame link meta noscript param rb rp rt rtc script
	source style template title track
`);

/** Whether an HTML start tag for `name` makes the browser reopen closed formatting elements. */
export function reopensFormatting(name: string): boolean {
	if (RECONSTRUCTING_SPECIALS.has(name)) return true;
	if (NON_RECONSTRUCTING.has(name) || SPECIAL_ELEMENTS.has(name)) return false;
	return !VOID_ELEMENTS.has(name) && !TABLE_PARTS.has(name) && !IGNORED_START_TAGS.has(name);
}

/** The last entry of an index list, or -1 when it is empty. */
const top = (list: readonly number[]): number =>
	list.length > 0 ? (list[list.length - 1] as number) : -1;

/** What an end tag does: nothing, close the element at `index` and all above it, or detach it. */
export type EndTagEffect =
	| { kind: 'none' }
	| { kind: 'close'; index: number }
	| { kind: 'detach'; index: number };

const NO_EFFECT: EndTagEffect = { kind: 'none' };

const DETACHED = ''; // the name a detached element leaves behind on the stack

/** The open elements, with the indexes the close decisions need. */
export class ElementStack {
	private readonly names: string[] = [];
	private readonly hides: boolean[] = [];
	private readonly namespaces: Namespace[] = [];
	private foreignCount = 0;
	private readonly formatting: Array<FormattingEntry | null> = [];
	private readonly byName = new Map<string, number[]>();
	private readonly specials: number[] = [];
	private readonly scope: number[] = [];
	private readonly tableScope: number[] = [];
	private readonly listScope: number[] = [];
	private readonly buttons: number[] = [];
	// Special elements other than `address`, `div` and `p`: they stop a new
	// `<li>`, `<dd>` or `<dt>` from closing an open one of its kind.
	private readonly listItemBlockers: number[] = [];
	private readonly tableSections: number[] = [];
	private readonly htmlElements: number[] = [];
	private readonly indexLists: number[][] = [
		this.specials,
		this.scope,
		this.tableScope,
		this.listScope,
		this.buttons,
		this.listItemBlockers,
		this.tableSections,
		this.htmlElements,
	];

	get depth(): number {
		return this.names.length;
	}

	/** Whether an element named `name` is open. */
	has(name: string): boolean {
		return this.nearest(name) !== -1;
	}

	/** Whether an SVG or MathML element is open. */
	hasForeign(): boolean {
		return this.foreignCount > 0;
	}

	/** The index of the highest open special element, or -1. */
	topSpecial(): number {
		return top(this.specials);
	}

	/** Whether an HTML select is open (not an SVG or MathML element of that name). */
	inSelect(): boolean {
		const select = this.nearest('select');
		return select !== -1 && this.namespaces[select] === '';
	}

	/** Whether the nearest table context is a table (not a template or none). */
	inTable(): boolean {
		const context = top(this.tableScope);
		return context !== -1 && this.names[context] === 'table';
	}

	/**
	 * The namespace a start tag for `name` opens its element in: inside SVG or
	 * MathML content (other than an integration point) it stays in that
	 * namespace, even `svg` or `math`; elsewhere `svg` and `math` start SVG and
	 * MathML.
	 */
	namespaceFor(name: string): Namespace {
		const context = this.foreignContext();
		if (context !== '') return context;
		return name === 'svg' || name === 'math' ? name : '';
	}

	/**
	 * Whether a start tag for `name` is read as SVG or MathML because of where
	 * it appears (inside SVG or MathML content it does not break out of), so the
	 * HTML rules for ignored tags, table parts, selects and implied closes do
	 * not apply to it.
	 */
	insideForeign(name: string): boolean {
		return !FOREIGN_BREAKOUT.has(name) && this.foreignContext() !== '';
	}

	/**
	 * The lowest SVG or MathML element an HTML tag breaks out of: every such
	 * element down to HTML or an integration point closes. -1 outside SVG and
	 * MathML content.
	 */
	foreignBreakout(meter?: { steps: number }): number {
		if (this.foreignContext() === '') return -1;
		let index = this.names.length - 1;
		while (index > 0) {
			if (meter) meter.steps++;
			const below = this.namespaces[index - 1] as Namespace;
			if (below === '' || isIntegrationPoint(below, this.names[index - 1] as string)) break;
			index--;
		}
		return index;
	}

	/** The current element's namespace when it is SVG or MathML content, else `''`. */
	private foreignContext(): Namespace {
		const current = this.names.length - 1;
		if (current < 0) return '';
		const namespace = this.namespaces[current] as Namespace;
		return isIntegrationPoint(namespace, this.names[current] as string) ? '' : namespace;
	}

	/**
	 * Push an element; `hides` records whether it hides its own content, and
	 * `entry` is its place on the active formatting list, if any.
	 */
	push(
		name: string,
		hides: boolean,
		namespace: Namespace,
		entry: FormattingEntry | null = null
	): number {
		const index = this.names.length;
		this.names.push(name);
		this.hides.push(hides);
		this.namespaces.push(namespace);
		if (namespace !== '') this.foreignCount++;
		this.formatting.push(entry);
		let positions = this.byName.get(name);
		if (!positions) {
			positions = [];
			this.byName.set(name, positions);
		}
		positions.push(index);
		if (namespace !== '') {
			// Only the SVG and MathML members of each category count here.
			if (isIntegrationPoint(namespace, name)) {
				this.specials.push(index);
				this.scope.push(index);
				this.listItemBlockers.push(index);
			}
		} else {
			if (SPECIAL_ELEMENTS.has(name) && !FOREIGN_SPECIAL_ELEMENTS.has(name)) {
				this.specials.push(index);
				if (name !== 'address' && name !== 'div' && name !== 'p') this.listItemBlockers.push(index);
			}
			if (SCOPE_BOUNDARIES.has(name) && !FOREIGN_SPECIAL_ELEMENTS.has(name)) this.scope.push(index);
			if (TABLE_SCOPE_BOUNDARIES.has(name)) this.tableScope.push(index);
			if (name === 'ol' || name === 'ul') this.listScope.push(index);
			if (name === 'button') this.buttons.push(index);
			if (name === 'tbody' || name === 'thead' || name === 'tfoot') this.tableSections.push(index);
			this.htmlElements.push(index);
		}
		return index;
	}

	/**
	 * Pop the element at `index` and everything above it, visiting each popped
	 * element from the top down.
	 */
	truncate(
		index: number,
		visit: (name: string, hides: boolean, at: number, entry: FormattingEntry | null) => void
	): void {
		while (this.names.length > index) {
			const name = this.names.pop() as string;
			const hides = this.hides.pop() as boolean;
			if (this.namespaces.pop() !== '') this.foreignCount--;
			const entry = this.formatting.pop() ?? null;
			const at = this.names.length;
			if (name !== DETACHED) this.byName.get(name)?.pop();
			for (const list of this.indexLists) {
				if (top(list) === at) list.pop();
			}
			visit(name, hides, at, entry);
		}
	}

	/**
	 * Take the element at `index` off the stack but leave the elements above it
	 * open, as the browser does for a formatting element with a special element
	 * above it, and for a form. It is the nearest element of its name.
	 */
	detach(index: number): FormattingEntry | null {
		this.byName.get(this.names[index] as string)?.pop();
		this.names[index] = DETACHED;
		this.hides[index] = false;
		const entry = this.formatting[index] ?? null;
		this.formatting[index] = null;
		return entry;
	}

	/** What an end tag for `name` does to the open elements. */
	endTag(name: string): EndTagEffect {
		if (name === 'body' || name === 'html') return NO_EFFECT;
		const current = this.names.length - 1;
		if (current < 0) return NO_EFFECT;

		// Inside SVG or MathML, an end tag closes the nearest element of its name
		// when only SVG or MathML elements sit above it.
		if (this.namespaces[current] !== '') {
			const index = this.nearest(name);
			if (index !== -1 && index > top(this.htmlElements)) return { kind: 'close', index };
		}

		if (HEADINGS.has(name)) {
			// Any heading end tag closes the nearest open heading.
			let index = -1;
			for (const heading of HEADINGS) index = Math.max(index, this.nearest(heading));
			return index !== -1 && index >= top(this.scope) ? { kind: 'close', index } : NO_EFFECT;
		}

		const index = this.nearest(name);
		if (index === -1) return NO_EFFECT;
		// `</form>` takes the form off the stack and leaves what is inside it open.
		if (name === 'form')
			return index === current ? { kind: 'close', index } : { kind: 'detach', index };

		if (FORMATTING_ELEMENTS.has(name)) {
			if (top(this.scope) > index) return NO_EFFECT;
			// With a special element above it the browser takes the formatting
			// element out of the tree and keeps what is above it open.
			return top(this.specials) > index ? { kind: 'detach', index } : { kind: 'close', index };
		}
		// An SVG or MathML element of that name closes by the ordinary rule.
		if (
			!SPECIAL_ELEMENTS.has(name) ||
			FOREIGN_SPECIAL_ELEMENTS.has(name) ||
			this.namespaces[index] !== ''
		) {
			return top(this.specials) > index ? NO_EFFECT : { kind: 'close', index };
		}

		let blocker = top(this.scope);
		if (TABLE_SCOPED_END_TAGS.has(name)) blocker = top(this.tableScope);
		else if (name === 'li') blocker = Math.max(blocker, top(this.listScope));
		else if (name === 'p') blocker = Math.max(blocker, top(this.buttons));
		// An element never blocks its own end tag.
		return blocker > index ? NO_EFFECT : { kind: 'close', index };
	}

	/**
	 * The lowest open element a start tag for `name` closes before it opens,
	 * other than a paragraph, or -1: SVG or MathML content an HTML tag breaks out
	 * of, a list item before a new one of its kind, whatever is open inside the
	 * current table part before a new cell, row or section, a table before a new
	 * table outside its cells, an option before a new option.
	 */
	impliedClose(name: string, meter?: { steps: number }): number {
		const current = this.names.length - 1;
		if (current < 0) return -1;
		if (FOREIGN_BREAKOUT.has(name)) {
			const breakout = this.foreignBreakout(meter);
			if (breakout !== -1) return breakout;
		}
		if (name === 'li' || name === 'dd' || name === 'dt') {
			const item =
				name === 'li' ? this.nearest('li') : Math.max(this.nearest('dd'), this.nearest('dt'));
			return item !== -1 && item >= top(this.listItemBlockers) ? item : -1;
		}
		if (name === 'table') {
			// A table directly inside a table (not in a cell or caption) ends it.
			if (!this.inTable()) return -1;
			const table = top(this.tableScope);
			const inside = Math.max(this.nearest('td'), this.nearest('th'), this.nearest('caption'));
			return inside < table ? table : -1;
		}
		if (TABLE_PARTS.has(name) && this.inTable()) {
			// Clear back to the row (cells), the table section (rows) or the table
			// (sections, captions and column groups).
			let context = top(this.tableScope);
			if (name === 'tr' || name === 'td' || name === 'th') {
				context = Math.max(context, top(this.tableSections));
			}
			if (name === 'td' || name === 'th') context = Math.max(context, this.nearest('tr'));
			return context + 1 <= current ? context + 1 : -1;
		}
		if (name === 'option' || name === 'optgroup') {
			return this.names[current] === 'option' ? current : -1;
		}
		if (name === 'button') {
			const button = this.nearest('button');
			return button !== -1 && button >= top(this.scope) ? button : -1;
		}
		return -1;
	}

	/**
	 * The open heading a heading start tag closes (after the paragraph): the
	 * current element, when it is a heading. Otherwise -1.
	 */
	impliedHeadingClose(name: string): number {
		const current = this.names.length - 1;
		return HEADINGS.has(name) && current >= 0 && HEADINGS.has(this.names[current] as string)
			? current
			: -1;
	}

	/**
	 * The table parts the browser opens implicitly before a start tag for `name`,
	 * once {@link impliedClose} has cleared back to the table context: a body
	 * section before a row, and a row before a cell.
	 */
	impliedTableParents(name: string): string[] {
		const current = this.names[this.names.length - 1];
		if (name === 'tr') return current === 'table' ? ['tbody'] : [];
		if (name === 'td' || name === 'th') {
			if (current === 'table') return ['tbody', 'tr'];
			if (current === 'tbody' || current === 'thead' || current === 'tfoot') return ['tr'];
		}
		return [];
	}

	/** The open paragraph a start tag for `name` closes (after {@link impliedClose}'s), or -1. */
	impliedParagraphClose(name: string): number {
		if (!CLOSES_PARAGRAPH.has(name)) return -1;
		const paragraph = this.nearest('p');
		return paragraph !== -1 && paragraph >= Math.max(top(this.scope), top(this.buttons))
			? paragraph
			: -1;
	}

	/**
	 * The lowest element above `index` that hides its content, or -1. Callers
	 * scan upwards from the last element they checked, so the scans stay linear.
	 */
	nextHiding(index: number, meter?: { steps: number }): number {
		for (let i = index + 1; i < this.names.length; i++) {
			if (meter) meter.steps++;
			if (this.hides[i]) return i;
		}
		return -1;
	}

	/** The stack index of the nearest open element named `name`, or -1. */
	nearest(name: string): number {
		const positions = this.byName.get(name);
		return positions ? top(positions) : -1;
	}
}
