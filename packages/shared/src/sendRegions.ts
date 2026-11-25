/**
 * Block conditions and repeats that a send resolves.
 *
 * A transactional email is rendered once, when it is saved, without the data a
 * send will carry. So the renderer leaves each conditional or repeated Block in
 * the stored HTML and plain text between two markers, and every send keeps,
 * drops or repeats that region against its own variables before it fills the
 * `{{tokens}}`. The stored body therefore holds every branch: the content scan
 * sees all of it, and each translation carries the same markers.
 *
 *     <!--owlat:if {condition}-->…<!--owlat:endif-->
 *     <!--owlat:each {repeat}-->…<!--owlat:endeach-->
 *
 * The payload is the Block's `condition` or `repeat` as JSON, percent-encoded
 * so it can hold neither `-->` nor `--`.
 *
 * Markers are read from the stored template only, never from a value: the
 * resolver splits the template into regions first and hands each kept segment
 * to the caller to fill, so a substituted value is never parsed for markers.
 * The renderer also drops any marker-shaped comment an author wrote into a
 * Block, so the only markers are the ones it emitted.
 */

import type { BlockCondition, BlockRepeat } from './types';

const MARKER_SOURCE = String.raw`<!--owlat:(if|endif|each|endeach)(?: ([^\s>]*))?-->`;

/** Every marker-shaped comment, emitted or forged. */
const markerPattern = () => new RegExp(MARKER_SOURCE, 'g');

const encodePayload = (payload: unknown): string =>
	encodeURIComponent(JSON.stringify(payload)).replace(/-/g, '%2D');

/** The opening marker of a conditional region. */
export const conditionRegionStart = (condition: BlockCondition): string =>
	`<!--owlat:if ${encodePayload(condition)}-->`;
export const CONDITION_REGION_END = '<!--owlat:endif-->';

/** The opening marker of a repeated region. */
export const repeatRegionStart = (repeat: BlockRepeat): string =>
	`<!--owlat:each ${encodePayload(repeat)}-->`;
export const REPEAT_REGION_END = '<!--owlat:endeach-->';

/** Does this body carry any region marker? */
export function hasSendRegions(content: string | undefined | null): boolean {
	return !!content && new RegExp(MARKER_SOURCE).test(content);
}

/** The body with every marker removed and every region kept, as written. */
export function stripSendRegionMarkers(content: string): string {
	return hasSendRegions(content) ? content.replace(markerPattern(), '') : content;
}

/** A send's variables: JSON values as the API accepts them. */
export type SendRegionVariables = Readonly<Record<string, unknown>>;

/**
 * A value as the condition compares it: the preview holds every value as the
 * text the author typed, so a number or boolean compares as its JSON text and
 * a list as its JSON. `null` is no value at all, as for a missing variable.
 */
function conditionText(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'string') return value;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * Whether a Block with this condition is shown. The editor preview and the
 * send both decide here. A variable exists when it has a value other than the
 * empty string: `false`, `0` and an empty list all exist, because the preview
 * reads them as the text `false`, `0` and `[]`. `null` and a missing variable
 * do not exist. An operator this code does not know shows the Block.
 */
export function evaluateBlockCondition(
	condition: Pick<BlockCondition, 'variable' | 'operator' | 'value'>,
	variables: SendRegionVariables
): boolean {
	const text = conditionText(variables[condition.variable]);
	switch (condition.operator) {
		case 'exists':
			return text !== undefined && text !== '';
		case 'notExists':
			return text === undefined || text === '';
		case 'equals':
			return text === condition.value;
		case 'notEquals':
			return text !== condition.value;
		case 'contains':
			return text !== undefined && condition.value !== undefined && text.includes(condition.value);
		default:
			return true;
	}
}

/** Most entries one repeated region renders, whatever its own `maxItems` says. */
export const MAX_REPEAT_ITEMS = 500;

/**
 * The entries a repeat iterates: a list, or (as the preview takes it) text
 * holding a JSON list. Anything else renders the region zero times.
 */
export function repeatItems(value: unknown): readonly unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value !== 'string' || value === '') return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** One entry of a repeated region, as the fill sees it. */
export interface RepeatItemScope {
	/** The name the region's tokens use for the entry: `{{alias.field}}`. */
	readonly alias: string;
	/** The entry's own fields; empty for an entry that is not an object. */
	readonly fields: Readonly<Record<string, unknown>>;
	/** The entry's position from 0, for `{{$index}}`. */
	readonly index: number;
}

/** Fills one kept segment of the template; `item` is set inside a repeat. */
export type SendRegionFill = (segment: string, item: RepeatItemScope | undefined) => string;

type RegionNode =
	| { kind: 'text'; text: string }
	| { kind: 'if'; condition: BlockCondition | null; children: RegionNode[] }
	| { kind: 'each'; repeat: BlockRepeat | null; children: RegionNode[] };

function decodePayload<T>(raw: string | undefined): T | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(raw));
		return parsed && typeof parsed === 'object' ? (parsed as T) : null;
	} catch {
		return null;
	}
}

function isCondition(value: BlockCondition | null): value is BlockCondition {
	return !!value && typeof value.variable === 'string' && typeof value.operator === 'string';
}

function isRepeat(value: BlockRepeat | null): value is BlockRepeat {
	return !!value && typeof value.variable === 'string' && typeof value.itemAlias === 'string';
}

/**
 * The template as a tree of regions. A closing marker without its opener is
 * dropped; an opener never closed keeps its content, unconditionally.
 */
function parseRegions(content: string): RegionNode[] {
	type Frame = {
		node: Extract<RegionNode, { kind: 'if' | 'each' }> | null;
		children: RegionNode[];
	};
	const stack: Frame[] = [{ node: null, children: [] }];
	const top = () => stack[stack.length - 1]!;
	let last = 0;
	for (const match of content.matchAll(markerPattern())) {
		const at = match.index;
		if (at > last) top().children.push({ kind: 'text', text: content.slice(last, at) });
		last = at + match[0].length;
		const tag = match[1];
		if (tag === 'if' || tag === 'each') {
			const node: Extract<RegionNode, { kind: 'if' | 'each' }> =
				tag === 'if'
					? { kind: 'if', condition: decodePayload<BlockCondition>(match[2]), children: [] }
					: { kind: 'each', repeat: decodePayload<BlockRepeat>(match[2]), children: [] };
			stack.push({ node, children: node.children });
			continue;
		}
		const want = tag === 'endif' ? 'if' : 'each';
		if (stack.length > 1 && top().node?.kind === want) {
			const closed = stack.pop()!;
			top().children.push(closed.node!);
		}
	}
	if (last < content.length) top().children.push({ kind: 'text', text: content.slice(last) });
	while (stack.length > 1) {
		const unclosed = stack.pop()!;
		top().children.push(...unclosed.children);
	}
	return stack[0]!.children;
}

function resolveNodes(
	nodes: readonly RegionNode[],
	variables: SendRegionVariables,
	fill: SendRegionFill,
	item: RepeatItemScope | undefined
): string {
	let out = '';
	for (const node of nodes) {
		if (node.kind === 'text') {
			out += fill(node.text, item);
		} else if (node.kind === 'if') {
			// A condition that does not decode shows its region, as the renderer
			// shows a Block whose condition it cannot evaluate.
			if (!isCondition(node.condition) || evaluateBlockCondition(node.condition, variables)) {
				out += resolveNodes(node.children, variables, fill, item);
			}
		} else if (isRepeat(node.repeat)) {
			const items = repeatItems(variables[node.repeat.variable]);
			const max = node.repeat.maxItems;
			const limit = Math.min(
				typeof max === 'number' && max >= 1 ? Math.floor(max) : items.length,
				MAX_REPEAT_ITEMS
			);
			for (let index = 0; index < Math.min(items.length, limit); index++) {
				const entry = items[index];
				const fields =
					entry && typeof entry === 'object' && !Array.isArray(entry)
						? (entry as Record<string, unknown>)
						: {};
				out += resolveNodes(node.children, variables, fill, {
					alias: node.repeat.itemAlias,
					fields,
					index,
				});
			}
		}
	}
	return out;
}

/**
 * The body a send delivers: each conditional region kept or dropped and each
 * repeated region written once per entry, against `variables`, with every
 * kept segment of the template passed through `fill`. A body without markers
 * is filled whole, so it comes out exactly as `fill` alone makes it.
 */
export function resolveSendRegions(
	content: string,
	variables: SendRegionVariables,
	fill: SendRegionFill
): string {
	if (!hasSendRegions(content)) return fill(content, undefined);
	return resolveNodes(parseRegions(content), variables, fill, undefined);
}
