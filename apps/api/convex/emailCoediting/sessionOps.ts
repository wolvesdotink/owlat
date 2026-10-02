/**
 * Email co-editing: applying a batch of editor operations to a session
 * (docs/adr/0071-email-coediting.md). Pure, so the merge rules are tested
 * without Convex.
 *
 * Operations are applied in arrival order; edits to different blocks never
 * interfere. When an operation writes a block or field that another editor
 * wrote after the sender last saw it (`baseVersion`), the later write wins and
 * the replaced value is reported, so the editor who lost it can be told and
 * can put it back. A move never replaces content and is not tracked.
 */

import {
	MAX_COEDIT_OPS_PER_BATCH,
	applyCoeditOps,
	coeditOpKey,
	sameCoeditValue,
	type CoeditDocument,
	type CoeditKey,
	type CoeditOp,
} from '@owlat/shared/coeditOps';
import { throwInvalidInput } from '../_utils/errors';
import { sanitizeStoredBlocksJson } from '../lib/emailContentSanitize';
import type { CoeditField, CoeditOpArg } from '../lib/validators/coediting';
import { isValidFieldValue, type StoredRootBlock } from './target';

/** Upper bound on a block id, a client id or a field key. */
export const MAX_COEDIT_ID_LENGTH = 128;

export interface CoeditWrite {
	key: string;
	version: number;
	clientId: string;
}

export interface SessionState {
	doc: CoeditDocument<StoredRootBlock>;
	writes: readonly CoeditWrite[];
	version: number;
}

/** An operation with the version its sender last saw its block or field at. */
export interface ParsedOp {
	op: CoeditOp<StoredRootBlock>;
	baseVersion: number | null;
}

/** A value an operation replaced: who wrote it, and what it was. */
export interface ReplacedWrite {
	key: CoeditKey;
	clientId: string;
	value: unknown;
}

function checkId(id: string, what: string): string {
	if (id.length === 0 || id.length > MAX_COEDIT_ID_LENGTH) {
		throwInvalidInput(`The ${what} is not valid.`);
	}
	return id;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return throwInvalidInput('An edit could not be read.');
	}
}

/**
 * Parse one block as sent: an object with an id and a type, its text HTML
 * sanitized like every other stored email content.
 */
export function parseBlock(json: string): StoredRootBlock {
	const sent = parseJson(json);
	const [block] = JSON.parse(sanitizeStoredBlocksJson(JSON.stringify([sent]))) as unknown[];
	if (
		typeof block !== 'object' ||
		block === null ||
		Array.isArray(block) ||
		typeof (block as { id?: unknown }).id !== 'string' ||
		typeof (block as { type?: unknown }).type !== 'string'
	) {
		return throwInvalidInput('An edited block is not valid.');
	}
	checkId((block as StoredRootBlock).id, 'block id');
	return block as StoredRootBlock;
}

/** Parse and check a batch against the fields the target shares. */
export function parseOps(
	ops: readonly CoeditOpArg[],
	allowedFields: readonly CoeditField[]
): ParsedOp[] {
	if (ops.length > MAX_COEDIT_OPS_PER_BATCH) {
		throwInvalidInput(`Send at most ${MAX_COEDIT_OPS_PER_BATCH} edits at once.`);
	}
	return ops.map((op): ParsedOp => {
		switch (op.kind) {
			case 'insert':
			case 'update':
				return {
					op: {
						kind: op.kind,
						block: parseBlock(op.block),
						afterId: op.afterId === null ? null : checkId(op.afterId, 'block id'),
					},
					baseVersion: op.baseVersion,
				};
			case 'delete':
				return {
					op: { kind: 'delete', blockId: checkId(op.blockId, 'block id') },
					baseVersion: op.baseVersion,
				};
			case 'move':
				return {
					op: {
						kind: 'move',
						blockId: checkId(op.blockId, 'block id'),
						afterId: op.afterId === null ? null : checkId(op.afterId, 'block id'),
					},
					baseVersion: null,
				};
			case 'field': {
				const value = parseJson(op.value);
				if (!allowedFields.includes(op.field) || !isValidFieldValue(op.field, value)) {
					throwInvalidInput('An edited field is not valid.');
				}
				return { op: { kind: 'field', field: op.field, value }, baseVersion: op.baseVersion };
			}
		}
	});
}

/** What `key` holds in `doc`: a block, a field value, or undefined. */
function valueAt(doc: CoeditDocument<StoredRootBlock>, key: CoeditKey): unknown {
	if (key.startsWith('field:')) return doc.fields[key.slice('field:'.length)];
	const id = key.slice('block:'.length);
	return doc.blocks.find((block) => block.id === id);
}

/** What an operation writes at its key (undefined for a delete). */
function writtenValue(op: CoeditOp<StoredRootBlock>): unknown {
	switch (op.kind) {
		case 'insert':
		case 'update':
			return op.block;
		case 'field':
			return op.value;
		default:
			return undefined;
	}
}

/**
 * Apply a batch from `clientId`. Returns the new state (one version further)
 * and every value it replaced that another editor wrote after the sender last
 * saw it, at most one per key.
 */
export function applySessionOps(
	state: SessionState,
	ops: readonly ParsedOp[],
	clientId: string
): { state: SessionState; replaced: ReplacedWrite[] } {
	const version = state.version + 1;
	const writes = new Map(state.writes.map((write) => [write.key, write]));
	const replaced = new Map<CoeditKey, ReplacedWrite>();
	let doc = state.doc;

	for (const { op, baseVersion } of ops) {
		const key = coeditOpKey(op);
		if (key !== null) {
			const last = writes.get(key);
			if (
				last &&
				last.clientId !== clientId &&
				baseVersion !== null &&
				last.version > baseVersion &&
				!replaced.has(key)
			) {
				const current = valueAt(doc, key);
				if (current !== undefined && !sameCoeditValue(current, writtenValue(op))) {
					replaced.set(key, { key, clientId: last.clientId, value: current });
				}
			}
			writes.set(key, { key, version, clientId });
		}
		doc = applyCoeditOps(doc, [op]);
	}

	// Forget the writers of blocks that are gone and of fields that are not
	// shared: the list stays as long as the document, not its history.
	const present = new Set(doc.blocks.map((block) => `block:${block.id}`));
	const kept = [...writes.values()].filter(
		(write) =>
			present.has(write.key) ||
			(write.key.startsWith('field:') && write.key.slice('field:'.length) in doc.fields)
	);

	return { state: { doc, writes: kept, version }, replaced: [...replaced.values()] };
}
