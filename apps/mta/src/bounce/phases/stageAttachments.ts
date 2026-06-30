/**
 * Phase: prepare attachment + header payload for an inbound-accept route.
 *
 * Reads the parsed mail's attachments and headers and emits an
 * `inbound_accept` BounceAttempt with the per-attachment input the reducer
 * needs to fan out `stage_attachment` effects. The actual Redis `SETEX`
 * writes happen inside the effect runner (`bounce/effects.ts`) — this
 * phase is pure data extraction.
 *
 * Named `stageAttachments` because its output drives the staging effects,
 * matching ADR-0007 follow-up #4's vocabulary. The phase always
 * `bounceTo`s — it never short-circuits to a different terminal because
 * by this point `resolveRoute` has already confirmed the inbound-accept
 * branch.
 */

import type { Phase } from '../pipeline.js';
import type { CtxWithAcceptRoute, InboundAttachmentInput } from '../types.js';

export const stageAttachmentsPhase: Phase<CtxWithAcceptRoute, CtxWithAcceptRoute> = {
	name: 'stage_attachments',
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

		const attachments: InboundAttachmentInput[] = (parsed.attachments ?? []).map(
			(att, index) => ({
				index,
				filename: att.filename ?? undefined,
				contentType: att.contentType ?? 'application/octet-stream',
				size: att.size ?? 0,
				contentBase64: att.content ? att.content.toString('base64') : undefined,
			}),
		);

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
