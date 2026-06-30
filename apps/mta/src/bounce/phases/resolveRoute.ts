/**
 * Phase: route the inbound mail to its delivery destination.
 *
 * Three terminal cases short-circuit with `bounceTo`:
 *   - personal mailbox match (Postbox cache hit)
 *   - non-`accept` inbound route (endpoint, hold, route_bounce)
 *   - no route at all (unrecognized)
 *
 * The fourth case — an inbound route in `accept` mode — `continue`s with
 * the ctx widened (`CtxWithAcceptRoute`) so `stageAttachments` can read
 * the route. Without an rcptTo we can't look up either table, so we
 * short-circuit to `unrecognized`.
 */

import { findRoute } from '../../inbound/router.js';
import { findMailboxRoute } from '../../inbound/mailboxResolver.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx, CtxWithAcceptRoute, MailboxAttachmentMeta } from '../types.js';

export const resolveRoutePhase: Phase<BasePhaseCtx, CtxWithAcceptRoute> = {
	name: 'resolve_route',
	async run(deps, ctx) {
		const { parsed, rcptTo, dkimResult, dmarcResult, dmarcPolicy } = ctx;

		if (!rcptTo) {
			return {
				kind: 'bounceTo',
				attempt: { kind: 'unrecognized', rcptTo: undefined },
			};
		}

		// 1. Personal-mailbox (Postbox) delivery — checked before generic
		//    routes because addresses can overlap with catch-all routes.
		const mailboxEntry = await findMailboxRoute(deps.redis, rcptTo);
		if (mailboxEntry) {
			const attachments: MailboxAttachmentMeta[] = (parsed.attachments ?? []).map(
				(att, attIdx) => ({
					filename: att.filename ?? `attachment-${attIdx}`,
					contentType: att.contentType ?? 'application/octet-stream',
					size: att.size ?? 0,
					contentId: att.contentId ?? undefined,
					partIndex: String(attIdx),
				}),
			);
			const referencesString = Array.isArray(parsed.references)
				? parsed.references.join(' ')
				: parsed.references ?? undefined;
			return {
				kind: 'bounceTo',
				attempt: {
					kind: 'mailbox',
					mailbox: mailboxEntry,
					rcptTo,
					attachments,
					toAddrs: extractAddrs(parsed.to),
					ccAddrs: extractAddrs(parsed.cc),
					bccAddrs: extractAddrs(parsed.bcc),
					references: referencesString,
					dkimResult,
					dmarcResult,
					dmarcPolicy,
				},
			};
		}

		// 2. Generic inbound route table.
		const route = await findRoute(deps.redis, rcptTo);
		if (!route) {
			return {
				kind: 'bounceTo',
				attempt: { kind: 'unrecognized', rcptTo },
			};
		}

		switch (route.mode) {
			case 'endpoint':
				return {
					kind: 'bounceTo',
					attempt: { kind: 'endpoint_forward', route, rcptTo },
				};
			case 'hold':
				return {
					kind: 'bounceTo',
					attempt: { kind: 'route_hold', route, rcptTo },
				};
			case 'bounce':
				return {
					kind: 'bounceTo',
					attempt: { kind: 'route_bounce', route, rcptTo },
				};
			case 'accept':
				return { kind: 'continue', ctx: { ...ctx, rcptTo, route } };
			case 'reject':
				// `reject` is enforced at onRcptTo time, so it shouldn't reach
				// this phase. Treat defensively as unrecognized so an stale
				// cache entry never silently drops mail.
				return {
					kind: 'bounceTo',
					attempt: { kind: 'unrecognized', rcptTo },
				};
		}
	},
};

function extractAddrs(
	field: import('mailparser').ParsedMail['to'] | import('mailparser').ParsedMail['cc'],
): string[] {
	if (!field) return [];
	const objects = Array.isArray(field) ? field : [field];
	const out: string[] = [];
	for (const obj of objects) {
		for (const v of obj.value ?? []) {
			if (v.address) out.push(v.address);
		}
	}
	return out;
}
