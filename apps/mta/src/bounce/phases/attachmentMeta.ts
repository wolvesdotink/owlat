/**
 * Phase: prepare attachment + header metadata for an inbound-accept route.
 *
 * Reads the parsed mail's attachments and headers and emits an
 * `inbound_accept` BounceAttempt carrying, per attachment, filename, content
 * type, size and — the part that makes it addressable — `partIndex`.
 *
 * THE BYTES DO NOT TRAVEL THROUGH THIS PHASE, and that is deliberate. It used
 * to base64 every attachment so the reducer could fan out `stage_attachment`
 * effects that `SETEX`-ed them into Redis for an hour under
 * `mta:inbound-att:<msgid>:<n>` — and nothing, anywhere, ever read one back.
 * That made inbound mail the highest bytes-per-key writer in the product
 * against a Redis capped by `--maxmemory` with `maxmemory-policy noeviction`,
 * where reaching the cap means Redis refuses writes and the MTA stops
 * accepting mail.
 *
 * The bytes reach Convex WHOLE instead, once: the reducer puts the entire
 * received message on the `inbound.received` payload as `rawBytesBase64` (see
 * `InboundEmailPayload` in `../../types.ts`), the team-inbox route
 * `POST /webhooks/mta-inbound` stores it sealed at `inboundMessages.rawStorageId`,
 * and the reader re-extracts one MIME part from that raw `.eml` by the
 * `partIndex` this phase emits. So the metadata here is an INDEX into the raw
 * message rather than a description of something unreachable — one copy of the
 * bytes, addressed per part, exactly as the personal-mailbox route
 * (`inbound.mailbox.received` → `mailMessages.rawStorageId`) has always worked.
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
