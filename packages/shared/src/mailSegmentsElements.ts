/**
 * The open-element stack behind `./mailSegmentsHtml`, and the element sets it
 * reads. It decides one thing the line model needs: whether text at the
 * current position is visible. Where a browser's tree builder is too involved
 * to follow exactly, it keeps hiding rather than showing, the same rule as the
 * security scan's hidden-markup strip (`agent/steps/security_scan/
 * hiddenMarkup.ts`):
 *   - a hidden formatting element (`<b hidden>`, `<font style=…>`) closed by
 *     something other than its own end tag keeps hiding until an end tag of
 *     its name, because the browser reopens formatting elements for the
 *     content that follows (`<div><b hidden>a</div>b</b>` hides both);
 *   - `<p>`, `<li>`, `<dd>`/`<dt>` close the way a browser closes them on a
 *     new block, item or term, so what follows is not wrongly hidden.
 *
 * Every operation is constant time or amortised over the pops it causes, and
 * counts its steps in the work meter.
 */
import type { QuoteContainer, SegmentWork } from './mailSegmentsSource';

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

const words = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

export const VOID = words(
	'area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr'
);
export const BLOCK = words(
	'address article aside blockquote center dd div dl dt figure footer form h1 h2 h3 h4 h5 h6 header li main nav ol p pre section table tbody td th thead tr ul'
);
/** Content is text up to the element's own end tag, never shown. */
export const RAW_HIDDEN = words('script style title iframe noembed noframes');
/** Content is text up to the element's own end tag, shown unless the element is hidden. */
export const RAW_SHOWN = words('textarea xmp');
/** Parsed normally, never shown (the scan's always-hidden set, plus `noscript`). */
export const PARSED_HIDDEN = words('template datalist rp noscript');
/** Elements the browser reopens after an implicit close. */
const FORMATTING = words('a b big code em font i nobr s small strike strong tt u');
/** Start tags that close an open `<p>` in button scope. */
const P_CLOSERS = words(
	'address article aside blockquote center details dialog dir div dl dd dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section summary table ul'
);
/** Elements that end the scope a `<p>` or `<dd>` is looked up in. */
const SCOPE = words('applet button caption html marquee object table td template th');
/** List-item scope adds the lists themselves. */
const LIST_SCOPE = words('applet button caption html marquee object ol table td template th ul');

interface OpenElement {
	name: string;
	hidden: boolean;
	container?: QuoteContainer;
}

export class ElementStack {
	private readonly stack: OpenElement[] = [];
	private readonly byName = new Map<string, number[]>();
	private readonly scope: number[] = [];
	private readonly listScope: number[] = [];
	/** Hidden formatting elements closed implicitly: they hide until their own end tag. */
	private readonly lingering = new Map<string, number>();
	private lingeringTotal = 0;
	private hiddenOpen = 0;
	quoteDepth = 0;
	pre = 0;
	readonly containers: QuoteContainer[] = [];
	private nextContainer = 0;

	constructor(private readonly work: SegmentWork) {}

	/** Whether text here is hidden, or might be. */
	get hidden(): boolean {
		return this.hiddenOpen > 0 || this.lingeringTotal > 0;
	}

	get container(): QuoteContainer | undefined {
		return this.containers[this.containers.length - 1];
	}

	/** Close what a start tag of `name` closes implicitly. */
	closeFor(name: string): void {
		if (P_CLOSERS.has(name)) this.closeInScope('p', this.scope);
		if (name === 'li') this.closeInScope('li', this.listScope);
		if (name === 'dd' || name === 'dt') {
			this.closeInScope('dd', this.scope);
			this.closeInScope('dt', this.scope);
		}
	}

	open(name: string, hidden: boolean, quoteContainer: boolean): void {
		const index = this.stack.length;
		const element: OpenElement = { name, hidden };
		if (quoteContainer) {
			element.container = { id: this.nextContainer++, last: Number.POSITIVE_INFINITY };
			this.containers.push(element.container);
		}
		this.stack.push(element);
		const indexes = this.byName.get(name) ?? [];
		indexes.push(index);
		this.byName.set(name, indexes);
		if (SCOPE.has(name)) this.scope.push(index);
		if (LIST_SCOPE.has(name)) this.listScope.push(index);
		if (hidden) this.hiddenOpen++;
		if (name === 'blockquote') this.quoteDepth++;
		if (name === 'pre') this.pre++;
	}

	/** An end tag: pops to the innermost open element of its name. Returns whether one was open. */
	close(name: string): boolean {
		const index = last(this.byName.get(name) ?? []);
		if (index === undefined) {
			const lingering = this.lingering.get(name) ?? 0;
			if (lingering > 0) {
				this.lingering.set(name, lingering - 1);
				this.lingeringTotal--;
			}
			return false;
		}
		this.popTo(index, true);
		return true;
	}

	/** Close everything still open at the end of the input. */
	finish(): void {
		for (const container of this.containers) container.last = this.nextContainer - 1;
	}

	private closeInScope(name: string, boundaries: number[]): void {
		this.work.steps++;
		const index = last(this.byName.get(name) ?? []);
		const boundary = last(boundaries) ?? -1;
		if (index !== undefined && index > boundary) this.popTo(index, false);
	}

	/** Pop every element from the top down to `index`; `ownEndTag` says the last one closed itself. */
	private popTo(index: number, ownEndTag: boolean): void {
		while (this.stack.length > index) {
			this.work.steps++;
			const at = this.stack.length - 1;
			const element = this.stack.pop() as OpenElement;
			this.byName.get(element.name)?.pop();
			if (last(this.scope) === at) this.scope.pop();
			if (last(this.listScope) === at) this.listScope.pop();
			if (element.hidden) {
				this.hiddenOpen--;
				const implicit = !(ownEndTag && at === index);
				if (implicit && FORMATTING.has(element.name)) {
					this.lingering.set(element.name, (this.lingering.get(element.name) ?? 0) + 1);
					this.lingeringTotal++;
				}
			}
			if (element.name === 'blockquote') this.quoteDepth--;
			if (element.name === 'pre') this.pre--;
			if (element.container) {
				element.container.last = this.nextContainer - 1;
				this.containers.pop();
			}
		}
	}
}
