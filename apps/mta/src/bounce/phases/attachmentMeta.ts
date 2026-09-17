/**
 * Phase: prepare attachment + header metadata for an inbound-accept route.
 *
 * Reads the parsed mail's attachments and headers and emits an
 * `inbound_accept` BounceAttempt carrying, per attachment, only what the
 * `inbound.received` webhook payload reports: filename, content type and size.
 *
 * It deliberately does NOT carry the bytes. This phase used to base64 every
 * attachment so the reducer could fan out `stage_attachment` effects that
 * `SETEX`-ed them into Redis for an hour under `mta:inbound-att:<msgid>:<n>` —
 * and nothing, anywhere, ever read one back. That made inbound mail the
 * highest bytes-per-key writer in the product against a Redis now capped by
 * `--maxmemory` with `maxmemory-policy noeviction`, where reaching the cap
 * means Redis refuses writes and the MTA stops accepting mail.
 *
 * Dropping it loses nothing that was reachable — no caller ever fetched one of
 * those copies. It does not make the bytes reachable either, and on THIS route
 * they never were: `InboundEmailPayload` (`../../types.ts`) has no raw field, and
 * Convex's `inboundMessages` stores only the `attachmentMeta` JSON. So the
 * team/AI-inbox route carries attachment METADATA ONLY — filename, content type
 * and size — and the bytes are not available downstream at all, before this
 * change or after it. That is a pre-existing product gap, not a design.
 *
 * The route that does carry the bytes is the personal-mailbox one: its
 * `inbound.mailbox.received` payload ships the whole message as `rawBytesBase64`,
 * Convex keeps it at `mailMessages.rawStorageId`, and the Postbox reader
 * re-extracts MIME parts from that raw `.eml` by `partIndex` (see
 * `MailboxAttachmentMeta`). Nothing equivalent exists here.
 */

import type { Phase } from '../pipeline.js';
import type { CtxWithAcceptRoute, InboundAttachmentInput } from '../types.js';

export const attachmentMetaPhase: Phase<CtxWithAcceptRoute, CtxWithAcceptRoute> = {
	name: 'attachment_meta',
	async run(_deps, ctx) {
		const { parsed, rcptTo, route } = ctx;

		const headers: Record<string, string> = {};
		if (parsed.headers) {
			for (const [key, value] of parsed.headers) {
				if (typeof value === 'string') {
					headers[key] = value;
				}
			}
		}

		const attachments: InboundAttachmentInput[] = (parsed.attachments ?? []).map((att, index) => ({
			index,
			filename: att.filename ?? undefined,
			contentType: att.contentType ?? 'application/octet-stream',
			size: att.size ?? 0,
		}));

		return {
			kind: 'bounceTo',
			attempt: {
				kind: 'inbound_accept',
				route,
				rcptTo,
				attachments,
				headers,
			},
		};
	},
};
