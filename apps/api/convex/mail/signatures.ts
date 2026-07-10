/**
 * Per-mailbox signatures.
 *
 * One default signature is automatically appended to new drafts (the
 * web composer reads `getDefault` on draft create). Users can have
 * multiple signatures and pick one per message via the composer toolbar.
 */

import { v } from 'convex/values';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';

// ── Signature detection from imported sent mail ─────────────────────────────

/** How many recent Sent messages to sample when detecting a signature. */
const SIGNATURE_SCAN_LIMIT = 120;
/** A detected signature block must appear in at least this many messages. */
const SIGNATURE_MIN_REPEATS = 2;
/** Reject a candidate block longer than this (chars) or taller than 8 lines. */
const SIGNATURE_MAX_DETECT_CHARS = 800;
const SIGNATURE_MAX_DETECT_LINES = 8;

/** Lines from here down are quoted/forwarded reply content, not the signature. */
const REPLY_MARKER =
	/^(>|On .+wrote:|-{3,}\s*Original Message|From:\s|Sent from my |Get Outlook for)/i;

/**
 * Extract the trailing signature block from one plain-text message body, or
 * `null`. Quoted reply content is stripped first; then the RFC 3676 `-- `
 * delimiter is preferred, falling back to the last contiguous run of non-empty
 * lines. The caller only trusts a block that repeats across several messages,
 * so the fallback's occasional false positive is filtered out by repetition.
 */
export function extractSignatureCandidate(body: string): string | null {
	const allLines = body.replace(/\r\n/g, '\n').split('\n');
	// Drop everything from the first reply/forward marker onward.
	const cutIndex = allLines.findIndex((line) => REPLY_MARKER.test(line.trim()));
	const lines = (cutIndex === -1 ? allLines : allLines.slice(0, cutIndex)).map((l) =>
		l.replace(/\s+$/, '')
	);

	// Prefer the standard "-- " signature delimiter (last one wins).
	let start = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]?.trim() === '--') {
			start = i + 1;
			break;
		}
	}

	let block: string[];
	if (start !== -1) {
		block = lines.slice(start);
	} else {
		// Fallback: the last contiguous run of non-empty lines.
		let end = lines.length;
		while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
		let begin = end;
		while (begin > 0 && (lines[begin - 1] ?? '').trim() !== '') begin--;
		block = lines.slice(begin, end);
	}

	const text = block.join('\n').trim();
	if (!text) return null;
	if (text.length > SIGNATURE_MAX_DETECT_CHARS) return null;
	if (block.filter((l) => l.trim() !== '').length > SIGNATURE_MAX_DETECT_LINES) return null;
	return text;
}

/**
 * Detect a repeated signature block across recent sent-message bodies. Returns
 * the most common trailing block that appears in at least
 * {@link SIGNATURE_MIN_REPEATS} messages, or `null` when nothing repeats.
 */
export function detectSignatureFromBodies(bodies: string[]): string | null {
	const counts = new Map<string, number>();
	for (const body of bodies) {
		const candidate = extractSignatureCandidate(body);
		if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [text, count] of counts) {
		if (count > bestCount || (count === bestCount && best !== null && text.length > best.length)) {
			best = text;
			bestCount = count;
		}
	}
	return bestCount >= SIGNATURE_MIN_REPEATS ? best : null;
}

/**
 * Hard cap on the post-sanitize signature size, in characters. Sanitize-html
 * does not bound the length of allowed CSS or attribute values, so a
 * legitimately-shaped signature could embed a multi-MB asset and balloon
 * every outbound message. 64 KB is comfortable for a rich signature with
 * a small avatar inlined via cid: but cuts off pathological cases.
 */
const SIGNATURE_MAX_CHARS = 64 * 1024;

/**
 * Sanitize signature HTML on save (not on render). A signature is the
 * one piece of Postbox HTML that ships into a recipient's mail client
 * without an iframe sandbox, so the allowlist is the only defense at
 * that boundary. Running on save means we store known-good HTML and
 * don't pay the cost on every send.
 */
function sanitizeSignature(html: string): string {
	const cleaned = sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
	if (cleaned.length > SIGNATURE_MAX_CHARS) {
		throw new Error(
			`Signature HTML exceeds the maximum allowed size (${SIGNATURE_MAX_CHARS} characters). Reduce inline content or upload assets as attachments.`
		);
	}
	return cleaned;
}

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailSignatures')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's signatures
	},
});

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const getDefault = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		return ctx.db
			.query('mailSignatures')
			.withIndex('by_mailbox_and_default', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('isDefault', true)
			)
			.first();
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		html: v.string(),
		isDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const trimmed = args.name.trim();
		if (!trimmed) throwInvalidInput('Signature name required');

		// Ensure only one default per mailbox
		if (args.isDefault) {
			const existingDefault = await ctx.db
				.query('mailSignatures')
				.withIndex('by_mailbox_and_default', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('isDefault', true)
				)
				.first();
			if (existingDefault) {
				await ctx.db.patch(existingDefault._id, { isDefault: false });
			}
		}

		const now = Date.now();
		return ctx.db.insert('mailSignatures', {
			mailboxId: args.mailboxId,
			name: trimmed,
			html: sanitizeSignature(args.html),
			isDefault: args.isDefault ?? false,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		signatureId: v.id('mailSignatures'),
		name: v.optional(v.string()),
		html: v.optional(v.string()),
		isDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const sig = await ctx.db.get(args.signatureId);
		if (!sig) throwNotFound('Signature');
		const owned = await requireMailboxAccess(ctx, sig.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');

		if (args.isDefault === true) {
			const existingDefault = await ctx.db
				.query('mailSignatures')
				.withIndex('by_mailbox_and_default', (q) =>
					q.eq('mailboxId', sig.mailboxId).eq('isDefault', true)
				)
				.first();
			if (existingDefault && existingDefault._id !== sig._id) {
				await ctx.db.patch(existingDefault._id, { isDefault: false });
			}
		}

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.name !== undefined) patch['name'] = args.name.trim();
		if (args.html !== undefined) patch['html'] = sanitizeSignature(args.html);
		if (args.isDefault !== undefined) patch['isDefault'] = args.isDefault;
		await ctx.db.patch(args.signatureId, patch);
	},
});

export const remove = authedMutation({
	args: { signatureId: v.id('mailSignatures') },
	handler: async (ctx, args) => {
		const sig = await ctx.db.get(args.signatureId);
		if (!sig) return;
		const owned = await requireMailboxAccess(ctx, sig.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.delete(args.signatureId);
	},
});

/**
 * Detect the user's own signature from recently imported Sent mail, for the
 * import wizard's completion screen to offer pre-filled. Samples the inline
 * bodies of the newest {@link SIGNATURE_SCAN_LIMIT} messages in the mailbox's
 * Sent folder and returns the repeated trailing block, or `null` when none
 * repeats (or the mailbox has no Sent folder / no imported inline bodies yet).
 * Never reads storage-backed bodies — this is a best-effort convenience.
 */
// public: soft-auth — returns null for anonymous; mailbox access is enforced in-handler
export const suggestFromImport = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;

		const sentFolder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', args.mailboxId).eq('role', 'sent'))
			.first();
		if (!sentFolder) return null;

		// Newest-first (highest UID) sample of the Sent folder, bounded read.
		const recent = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', sentFolder._id))
			.order('desc')
			.take(SIGNATURE_SCAN_LIMIT);

		const bodies = recent
			.map((m) => m.textBodyInline)
			.filter((b): b is string => typeof b === 'string' && b.trim().length > 0);
		if (bodies.length === 0) return null;

		return detectSignatureFromBodies(bodies);
	},
});
