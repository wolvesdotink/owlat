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
