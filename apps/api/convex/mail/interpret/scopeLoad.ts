/**
 * The action half of interpretation scoping: load a source through
 * `scope.ts` `loadSourceForScope` (the stored row and its body fingerprint, in
 * one query), open its body in the action (inline parts unsealed, storage
 * blobs read back) and apply `scopeBody`.
 *
 * Kept apart from `scope.ts` so the loader is called from another module, as
 * every Convex entry point must be (`scripts/check-entry-wiring.ts`).
 * Isolate-safe (no `'use node'`): runs in any action.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { SignedBodyScope } from '@owlat/shared/signedScope';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import {
	openMailMessageInlineBody,
	openMessageBody,
	readMailMessageText,
} from '../../lib/messageBody';
import { openInboundMessageBody } from '../../lib/messageBodyInbound';
import { readSealedBlobText } from '../../lib/sealedBlob';
import { scopeBody, type ScopedMessage } from './scope';

async function openMailRow(ctx: ActionCtx, row: Doc<'mailMessages'>) {
	const inline = await openMailMessageInlineBody(row);
	const text = inline.text ?? (await readMailMessageText(ctx.storage, row));
	let html = inline.html;
	if (html === undefined && row.htmlBodyStorageId) {
		html = (await readSealedBlobText(ctx.storage, row.htmlBodyStorageId)) || undefined;
	}
	return { text: text || undefined, html };
}

/** Load, open and scope one source message for interpretation. Null when it is gone. */
export async function scopeForInterpretation(
	ctx: ActionCtx,
	source: InterpretationSource
): Promise<ScopedMessage | null> {
	const loaded = await ctx.runQuery(internal.mail.interpret.scope.loadSourceForScope, { source });
	if (!loaded) return null;
	if (loaded.kind === 'teamReplyMissing') {
		return { ok: false, skipReason: 'ineligible', detail: 'no_snapshot' };
	}
	if (loaded.kind === 'teamReply') {
		return {
			ok: true,
			text: await openMessageBody(loaded.sealedText),
			subject: loaded.subject,
			sourceVersion: loaded.sourceVersion,
			omitted: [],
		};
	}
	if (loaded.kind === 'mail') {
		const row = loaded.row;
		const body = await openMailRow(ctx, row);
		const scoped = scopeBody({
			...body,
			subject: row.subject,
			attachments: row.attachments,
			signatureInfo: row.inboundSignatureInfo,
		});
		return scoped.ok ? { ...scoped, sourceVersion: loaded.sourceVersion } : scoped;
	}
	const row = loaded.row;
	const body = await openInboundMessageBody(row, ctx.storage);
	const text = body.text ?? (body.isComplete ? undefined : body.excerpt);
	const scoped = scopeBody({
		...(text !== undefined ? { text } : {}),
		...(body.html !== undefined ? { html: body.html } : {}),
		subject: row.subject,
		attachments: [],
	});
	if (!scoped.ok) return scoped;
	if (!body.isComplete) scoped.omitted.push('body_unavailable');
	return { ...scoped, sourceVersion: loaded.sourceVersion };
}

/**
 * Whether a new signature verdict changes what interpretation reads of a
 * stored mail message: its opened body scoped under the stored verdict and
 * under `next`. A MIME scope reads the body as it is; a clearsigned one can
 * narrow it to the signed block (`mail/mailbox/signatureReverify.ts`).
 */
export async function isMailReadChangedBy(
	ctx: ActionCtx,
	messageId: Id<'mailMessages'>,
	next: { isSigned?: boolean; scope?: SignedBodyScope }
): Promise<boolean> {
	const loaded = await ctx.runQuery(internal.mail.interpret.scope.loadSourceForScope, {
		source: { kind: 'mail', id: messageId },
	});
	if (!loaded || loaded.kind !== 'mail') return false;
	const row = loaded.row;
	const body = await openMailRow(ctx, row);
	const readUnder = (signatureInfo: typeof next | undefined) => {
		const scoped = scopeBody({
			...body,
			subject: row.subject,
			attachments: row.attachments,
			signatureInfo,
		});
		return JSON.stringify(
			scoped.ok ? [scoped.text ?? null, scoped.html ?? null, scoped.omitted] : scoped.skipReason
		);
	};
	return readUnder(row.inboundSignatureInfo) !== readUnder(next);
}
