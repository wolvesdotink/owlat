/**
 * Repair for email documents that repeat a Block or accordion-section id
 * (issue #1083, migration 0055).
 *
 * Before duplication renewed descendant ids, duplicating a Container, Hero,
 * Columns or Accordion gave only the copied root a new id, and inserting the
 * same saved Block twice did the same for Hero children and accordion
 * sections. The copies then share ids:
 *
 * - an accordion section id becomes the `owlat-acc-*` input/label id in the
 *   sent email, so a header in the second copy toggles the first copy;
 * - translation overlays are keyed by Block id, so one overlay entry applies
 *   to both copies and translating one copy changes the other.
 *
 * The repair keeps the first occurrence of each id (document order) and gives
 * every later one a fresh id. For a renewed Block it copies the overlay entry
 * of the old id to the new id in every language, so both copies keep the
 * translation they show today and can diverge from then on. Section ids are
 * not translation keys, so renewing them touches no overlay.
 *
 * Pure: no Convex-runtime imports, so the migration and its tests share it.
 */

import {
	childBlockLists,
	ownedEntries,
	repeatedBlockIdRenewals,
	type BlockTreeNode,
} from '@owlat/shared/blockTree';
import type { Translation } from './emailTranslations';

/** How many ids one document repair renewed. Both zero: nothing was touched. */
export interface RepeatedIdCounts {
	blocks: number;
	sections: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isNode = (value: unknown): value is BlockTreeNode =>
	isRecord(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string';

const entryId = (entry: Record<string, unknown>): string =>
	typeof entry['id'] === 'string' ? entry['id'] : '';

/** Every Block id, section id and overlay key in use, so a fresh id never collides. */
function idsInUse(roots: BlockTreeNode[], translations: Record<string, Translation>): Set<string> {
	const ids = new Set<string>();
	const visit = (node: BlockTreeNode): void => {
		ids.add(node.id);
		for (const entry of ownedEntries(node)) ids.add(entryId(entry));
		for (const list of childBlockLists(node)) for (const child of list) visit(child);
	};
	for (const root of roots) visit(root);
	for (const translation of Object.values(translations)) {
		if (isRecord(translation?.blocks)) {
			for (const key of Object.keys(translation.blocks)) ids.add(key);
		}
	}
	return ids;
}

/**
 * Renew every repeated Block and section id in `roots`, in place, and copy the
 * overlay entries of renewed Blocks in `translations`, in place.
 */
export function repairRepeatedBlockIds(
	roots: BlockTreeNode[],
	translations: Record<string, Translation>,
	newId: () => string
): RepeatedIdCounts {
	const taken = idsInUse(roots, translations);
	const freshId = (): string => {
		let id = newId();
		while (taken.has(id)) id = newId();
		taken.add(id);
		return id;
	};

	const seenBlocks = new Set<string>();
	const seenSections = new Set<string>();
	const counts: RepeatedIdCounts = { blocks: 0, sections: 0 };

	const visit = (node: BlockTreeNode): void => {
		if (seenBlocks.has(node.id)) {
			const renewed = freshId();
			for (const translation of Object.values(translations)) {
				const overlay = isRecord(translation?.blocks) ? translation.blocks[node.id] : undefined;
				if (overlay) translation.blocks[renewed] = { ...overlay };
			}
			node.id = renewed;
			counts.blocks++;
		}
		seenBlocks.add(node.id);

		for (const entry of ownedEntries(node)) {
			if (seenSections.has(entryId(entry))) {
				entry['id'] = freshId();
				counts.sections++;
			}
			seenSections.add(entryId(entry));
		}

		for (const list of childBlockLists(node)) for (const child of list) visit(child);
	};
	for (const root of roots) visit(root);
	return counts;
}

/**
 * The stored `content` JSON with its root Block list, in the shapes
 * `parseContentBlocks` reads; null when it is not JSON.
 */
function parseDocument(content: string): { document: unknown; roots: BlockTreeNode[] } | null {
	let document: unknown;
	try {
		document = JSON.parse(content);
	} catch {
		return null;
	}
	return { document, roots: rootEntries(document).filter(isNode) };
}

/** The root entry list of a parsed `content` document, unfiltered. */
function rootEntries(document: unknown): unknown[] {
	if (Array.isArray(document)) return document;
	if (isRecord(document) && Array.isArray(document['blocks'])) return document['blocks'];
	return isRecord(document) && typeof document['type'] === 'string' ? [document] : [];
}

/** The row's overlays: `{}` when it has none, null when the stored JSON is not an object. */
function parseOverlays(blob: string | undefined): Record<string, Translation> | null {
	if (blob === undefined) return {};
	try {
		const value: unknown = JSON.parse(blob);
		return isRecord(value) ? (value as Record<string, Translation>) : null;
	} catch {
		return null;
	}
}

export type RowRepair =
	| { kind: 'unchanged' }
	/** `content` or `translations` is not JSON this repair can read; the row is left alone. */
	| { kind: 'unreadable'; field: 'content' | 'translations' }
	| { kind: 'repaired'; content: string; translations?: string; counts: RepeatedIdCounts };

/**
 * Repair one stored row's `content` and `translations` together. `translations`
 * is returned only when the row has one; a row with no repeated id is
 * `unchanged` and must not be written.
 */
export function repairRowRepeatedIds(
	row: { content: string; translations?: string },
	newId: () => string
): RowRepair {
	const parsed = parseDocument(row.content);
	if (!parsed) return { kind: 'unreadable', field: 'content' };

	const translations = parseOverlays(row.translations);
	const counts = repairRepeatedBlockIds(parsed.roots, translations ?? {}, newId);
	if (counts.blocks === 0 && counts.sections === 0) return { kind: 'unchanged' };
	// Renewing ids without carrying the overlays over would drop a copy's
	// translation, so a row whose overlays cannot be read is not repaired.
	if (!translations) return { kind: 'unreadable', field: 'translations' };
	return {
		kind: 'repaired',
		content: JSON.stringify(parsed.document),
		...(row.translations !== undefined && { translations: JSON.stringify(translations) }),
		counts,
	};
}

/** Every Block id in a stored `content` document, at any depth. */
function blockIdsOf(content: string): Set<string> {
	const ids = new Set<string>();
	const parsed = parseDocument(content);
	const visit = (node: BlockTreeNode): void => {
		ids.add(node.id);
		for (const list of childBlockLists(node)) for (const child of list) visit(child);
	};
	for (const root of parsed?.roots ?? []) visit(root);
	return ids;
}

/**
 * The row's `translations` with the overlays carried to the ids the editor
 * gave repeated Blocks; null when nothing changes.
 *
 * The editor renews every repeat of a Block id when it loads a document
 * (#1430), with the deterministic `normalizeBlockTreeIds`. Saving that
 * document would otherwise leave each renewed copy without the translation it
 * shared until then. `repeatedBlockIdRenewals` of the stored `previousContent`
 * names the ids the editor chose; each one present in `nextContent` gets, in
 * every language, a copy of the overlay entry of the id it renews (as
 * `repairRepeatedBlockIds` does), or loses a stale entry under that id when
 * the original had none. A renewed id is never in `previousContent`, so a
 * Block that already existed is never touched.
 */
export function carryRenewedBlockOverlays(
	previousContent: string,
	nextContent: string,
	translationsBlob: string | undefined
): string | null {
	let previous: unknown;
	try {
		previous = JSON.parse(previousContent);
	} catch {
		return null;
	}
	const renewals = repeatedBlockIdRenewals(rootEntries(previous));
	if (renewals.length === 0) return null;
	const translations = parseOverlays(translationsBlob);
	if (!translations) return null;

	const kept = blockIdsOf(nextContent);
	let changed = false;
	for (const { from, to } of renewals) {
		if (!kept.has(to)) continue;
		for (const translation of Object.values(translations)) {
			if (!isRecord(translation?.blocks)) continue;
			const blocks = translation.blocks;
			if (Object.prototype.hasOwnProperty.call(blocks, from)) blocks[to] = { ...blocks[from] };
			else if (Object.prototype.hasOwnProperty.call(blocks, to)) delete blocks[to];
			else continue;
			changed = true;
		}
	}
	return changed ? JSON.stringify(translations) : null;
}
