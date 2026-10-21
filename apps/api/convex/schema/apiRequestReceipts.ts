import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** The key-authed endpoints that honour an `Idempotency-Key` header. */
export const receiptEndpointValidator = v.union(v.literal('transactional'), v.literal('events'));

export const apiRequestReceiptTables = {
	// One row per (organization, Idempotency-Key) a send request committed under
	// (`auth/apiRequestReceipts.ts`). It is written in the transaction that
	// performs the send, so a row exists exactly when the effects do, and a
	// repeat of the request is answered from it instead of sending again.
	//
	// Only the response fields the request cannot reproduce are kept: ids, flags
	// and the resolved language. The address, template variables, attachment
	// bytes and signed URLs never land here; a replay rebuilds the request echoes
	// from the repeated request, which `requestHash` proves identical.
	apiRequestReceipts: defineTable({
		organizationId: v.string(),
		idempotencyKey: v.string(),
		endpoint: receiptEndpointValidator,
		// SHA-256 (hex) of the canonical endpoint + validated request.
		requestHash: v.string(),
		contactId: v.id('contacts'),
		isContactCreated: v.boolean(),
		// `transactional`: the queued Send and the language it went out in.
		sendId: v.optional(v.id('transactionalSends')),
		language: v.optional(v.string()),
		// `events`: the event id handed to the caller and the automations it started.
		eventId: v.optional(v.string()),
		triggeredAutomations: v.optional(v.number()),
		createdAt: v.number(),
		// Lookups ignore a row past this; the sweep only reclaims the space.
		expiresAt: v.number(),
	})
		.index('by_org_key', ['organizationId', 'idempotencyKey'])
		.index('by_expiry', ['expiresAt'])
		// Contact erasure deletes a person's receipts, and a merge moves them.
		.index('by_contact', ['contactId']),
};
