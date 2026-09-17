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
 * Attachment bytes are not lost by dropping it: the personal-mailbox route
 * already ships the full raw RFC822 to Convex and the reader re-extracts MIME
 * parts from that (see `MailboxAttachmentMeta`), which is the design this route
 * follows too.
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
