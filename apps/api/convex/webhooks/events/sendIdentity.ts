/**
 * The three fields every `email.*` webhook event carries to name the send
 * behind it, so a receiver can match an event to the request that caused it.
 *
 * - `sendId` is the id `POST /api/v1/transactional` answered with (its
 *   `transactionalEmailId`), and the id `GET /api/v1/transactional/{sendId}`
 *   reads. It is set only for sends that API created: a campaign, automation
 *   or inbox send has no id a caller could look up, so it carries `null`
 *   rather than an internal row id.
 * - `campaignId` names the campaign of a campaign send.
 * - `templateId` names the transactional template of an API send.
 *
 * Each field is always present, `null` when it does not apply, so receivers
 * can rely on the keys existing.
 */

import { v } from 'convex/values';

export const sendIdentityFields = {
	sendId: v.union(v.string(), v.null()),
	campaignId: v.union(v.string(), v.null()),
	templateId: v.union(v.string(), v.null()),
};

export interface SendIdentity {
	readonly sendId: string | null;
	readonly campaignId: string | null;
	readonly templateId: string | null;
}

/** The identity fields as they go on the wire, copied so no extra key rides along. */
export function sendIdentityData(identity: SendIdentity): SendIdentity {
	return {
		sendId: identity.sendId,
		campaignId: identity.campaignId,
		templateId: identity.templateId,
	};
}
