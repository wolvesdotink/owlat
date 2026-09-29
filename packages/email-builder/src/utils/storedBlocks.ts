import type { EditorBlock } from '../types';
import { generateId } from './id';

/**
 * Stored block bodies — the one reader for the block JSON the backend keeps on
 * email templates, transactional emails, their translations and saved blocks.
 *
 * Three shapes exist in stored rows:
 * - a bare `EditorBlock[]` (emails, transactional emails, translations);
 * - the `{ blocks: EditorBlock[] }` envelope the saved-block editor writes;
 * - a legacy single `{ type, content }` block from saved blocks created before
 *   the envelope existed.
 *
 * Tolerant by construction: invalid JSON or any other shape reads as `[]`, and
 * entries that are not an object with a string `type` are dropped so a
 * partially corrupt body keeps what it can. An entry without a string `id`
 * (legacy content never had one) gets a fresh one.
 */
export function parseStoredBlocks(content: string | null | undefined): EditorBlock[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content || '[]');
	} catch {
		return [];
	}
	return storedEntries(parsed).filter(isBlockEntry).map(withId);
}

/** The fields the reader inspects on a parsed JSON object. */
interface StoredObject {
	id?: unknown;
	type?: unknown;
	content?: unknown;
	blocks?: unknown;
}

type BlockEntry = StoredObject & { type: string };

function isObject(value: unknown): value is StoredObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlockEntry(value: unknown): value is BlockEntry {
	return isObject(value) && typeof value.type === 'string';
}

/** The raw entry list for whichever stored shape `parsed` is. */
function storedEntries(parsed: unknown): unknown[] {
	if (Array.isArray(parsed)) return parsed;
	if (!isObject(parsed)) return [];
	if (Array.isArray(parsed.blocks)) return parsed.blocks;
	if (typeof parsed.type === 'string' && isObject(parsed.content)) return [parsed];
	return [];
}

function withId(entry: BlockEntry): EditorBlock {
	const block = typeof entry.id === 'string' ? entry : { ...entry, id: generateId('block') };
	return block as unknown as EditorBlock;
}
