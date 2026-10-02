/**
 * Email co-editing: the email a session belongs to (docs/adr/0071-email-coediting.md).
 *
 * Two editors co-edit: email templates (also the content of every campaign)
 * and transactional emails. A target names one of them; these helpers load
 * it, find its session and presence, and translate between the email row and
 * the shared editor state (root blocks plus named fields).
 *
 * Not a Convex function module: the leading helpers are imported by the
 * sibling `sessions.ts`, `presence.ts`, `notices.ts` and by the two email
 * `update` mutations.
 */

import { generateId } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getOrThrow } from '../_utils/errors';
import { assertFeatureEnabled } from '../lib/featureFlags';
import type { CoeditField, CoeditTarget } from '../lib/validators/coediting';

/** Shape version of a session's `fields` JSON (and of notice values). */
export const COEDIT_FIELDS_VERSION = 1;

/** A presence row is active while its heartbeat is this recent (the client beats every 10s). */
export const COEDIT_PRESENCE_WINDOW_MS = 35_000;

/** How long an edit lease on a block lasts past the heartbeat that took or renewed it. */
export const COEDIT_LEASE_TTL_MS = 20_000;

export type CoeditRow = Doc<'emailTemplates'> | Doc<'transactionalEmails'>;
export type CoeditSession = Doc<'emailCoeditSessions'>;

/** A root block as the session stores it. */
export interface StoredRootBlock {
	id: string;
	type: string;
	[key: string]: unknown;
}

/** The polymorphic reference columns for a target (see schema/emailCoediting.ts). */
export function targetFields(target: CoeditTarget) {
	return target.type === 'emailTemplate'
		? { targetType: 'emailTemplate' as const, emailTemplateId: target.id }
		: { targetType: 'transactionalEmail' as const, transactionalEmailId: target.id };
}

/** The target a stored co-editing row points at. */
export function rowTarget(row: {
	emailTemplateId?: CoeditTarget['id'];
	transactionalEmailId?: CoeditTarget['id'];
	targetType: CoeditTarget['type'];
}): CoeditTarget | null {
	if (row.targetType === 'emailTemplate' && row.emailTemplateId) {
		return { type: 'emailTemplate', id: row.emailTemplateId as Doc<'emailTemplates'>['_id'] };
	}
	if (row.targetType === 'transactionalEmail' && row.transactionalEmailId) {
		return {
			type: 'transactionalEmail',
			id: row.transactionalEmailId as Doc<'transactionalEmails'>['_id'],
		};
	}
	return null;
}

/**
 * Load the email, or throw `not_found`. A transactional target also needs
 * the `transactional` feature, like every function of that editor.
 */
export async function loadTarget(
	ctx: QueryCtx | MutationCtx,
	target: CoeditTarget
): Promise<CoeditRow> {
	if (target.type === 'transactionalEmail') {
		await assertFeatureEnabled(ctx, 'transactional');
		return await getOrThrow(ctx, target.id, 'Transactional email');
	}
	return await getOrThrow(ctx, target.id, 'Email template');
}

/** The email's live session, if one is open. */
export async function findSession(
	ctx: QueryCtx | MutationCtx,
	target: CoeditTarget
): Promise<CoeditSession | null> {
	if (target.type === 'emailTemplate') {
		return await ctx.db
			.query('emailCoeditSessions')
			.withIndex('by_email_template', (q) => q.eq('emailTemplateId', target.id))
			.first();
	}
	return await ctx.db
		.query('emailCoeditSessions')
		.withIndex('by_transactional_email', (q) => q.eq('transactionalEmailId', target.id))
		.first();
}

/** Presence rows for the email whose heartbeat is inside the active window. */
export async function activePresence(
	ctx: QueryCtx | MutationCtx,
	target: CoeditTarget,
	now: number
): Promise<Doc<'emailEditorPresence'>[]> {
	const since = now - COEDIT_PRESENCE_WINDOW_MS;
	if (target.type === 'emailTemplate') {
		return await ctx.db
			.query('emailEditorPresence')
			.withIndex('by_email_template_heartbeat', (q) =>
				q.eq('emailTemplateId', target.id).gt('heartbeatAt', since)
			)
			.collect(); // bounded: one row per open editor tab on this email (team size)
	}
	return await ctx.db
		.query('emailEditorPresence')
		.withIndex('by_transactional_email_heartbeat', (q) =>
			q.eq('transactionalEmailId', target.id).gt('heartbeatAt', since)
		)
		.collect(); // bounded: one row per open editor tab on this email (team size)
}

/** The fields each editor shares next to its blocks. */
export const TARGET_FIELDS: Record<CoeditTarget['type'], readonly CoeditField[]> = {
	emailTemplate: ['name', 'subject', 'plainTextOverride'],
	transactionalEmail: ['name', 'subject', 'plainTextOverride', 'attachments', 'showUnsubscribe'],
};

function parseAttachments(json: string | undefined): unknown[] {
	try {
		const parsed: unknown = JSON.parse(json || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * The shared fields as the editor holds them, read from the email row. The
 * values match the editor's own refs (attachments as a list, not JSON text).
 */
export function rowFields(target: CoeditTarget, row: CoeditRow): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		name: row.name,
		subject: row.subject,
		plainTextOverride: row.plainTextOverride ?? '',
	};
	if (target.type === 'transactionalEmail') {
		const email = row as Doc<'transactionalEmails'>;
		fields['attachments'] = parseAttachments(email.attachments);
		fields['showUnsubscribe'] = email.showUnsubscribe ?? false;
	}
	return fields;
}

/** Whether `value` is a valid value for `field`. */
export function isValidFieldValue(field: CoeditField, value: unknown): boolean {
	switch (field) {
		case 'name':
		case 'subject':
		case 'plainTextOverride':
			return typeof value === 'string';
		case 'attachments':
			return Array.isArray(value);
		case 'showUnsubscribe':
			return typeof value === 'boolean';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The root blocks of stored email content, ready to be edited block by block:
 * the `{ blocks }` envelope and a legacy single block are unwrapped, entries
 * that are not blocks are dropped, and a root without an id, or repeating an
 * earlier root's id, gets a fresh one (operations address blocks by id).
 * Mirrors the editor's `parseStoredBlocks`.
 */
export function rootBlocksOf(content: string): StoredRootBlock[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content || '[]');
	} catch {
		return [];
	}
	let entries: unknown[] = [];
	if (Array.isArray(parsed)) entries = parsed;
	else if (isRecord(parsed) && Array.isArray(parsed['blocks'])) entries = parsed['blocks'];
	else if (isRecord(parsed) && typeof parsed['type'] === 'string') entries = [parsed];

	const seen = new Set<string>();
	const roots: StoredRootBlock[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry['type'] !== 'string') continue;
		let id = typeof entry['id'] === 'string' ? entry['id'] : '';
		if (!id || seen.has(id)) id = generateId('block');
		seen.add(id);
		roots.push({ ...entry, id, type: entry['type'] });
	}
	return roots;
}

/** Saved blocks linked from the root blocks (the editor's `linkedBlockIds`). */
export function linkedBlockIdsOf(blocks: readonly StoredRootBlock[]): string[] {
	const ids = new Set<string>();
	for (const block of blocks) {
		const ref = block['savedBlockRef'];
		if (isRecord(ref) && typeof ref['blockId'] === 'string') ids.add(ref['blockId']);
	}
	return [...ids];
}
