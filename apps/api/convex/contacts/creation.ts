/**
 * Contact creation (module) — the uniform created-effect bundle.
 *
 * Wraps the effect-free **Contact resolution (module)** and, on
 * `action === 'created'`, fires the three effects that every single-Contact
 * create path must produce identically:
 *   1. `incrementContactCount(ctx, 1)`      — keep `cachedContactCount` true.
 *   2. `contact_created` automation trigger  — run "on new contact" automations.
 *   3. `created` Contact activity            — first-touch timeline, `metadata.source`.
 *
 * Every single-create caller routes through `createContact` instead of calling
 * `resolveContact` directly: the four strict mutations (`contacts.ts:create` /
 * `createForTeam`, `organization.ts:createForOrganization` /
 * `createForOrganizationInternal`) and the four upsert inbound paths
 * (`inbox/messages.ts`, `webhooks/channels.ts`, `transactional/dispatch.ts`,
 * `forms/submission.ts`). Callers keep their own domain effects on top (e.g.
 * inbox's `inbound_received` activity); this module owns only the trio.
 *
 * The **Contact import (module)** is the sole exception — it calls
 * `resolveContact` directly and fires one *batched* `incrementContactCount`
 * per page (ADR-0019). Keeping the trio in this layer *above* the still-
 * effect-free resolution primitive — not inside it — is what lets import's
 * batched count and the single-create trio coexist without double-counting.
 *
 * Created-effects only: the callers run `strict`/`upsert`, which never yield
 * `action: 'updated'` (only `merge` does, and only import uses it).
 *
 * See docs/adr/0038-contact-creation-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	resolveContact,
	channelKindValidator,
	contactSourceValidator,
	resolveModeValidator,
	contactFieldsValidator,
	type ResolveSignal,
	type ResolveResult,
} from './resolution';
import { incrementContactCount } from '../lib/contactCountHelpers';
import { recordContactActivity } from '../contactActivities/writer';
import { scheduleFanout } from '../webhooks/scheduleFanout';

/**
 * Find-or-create a single Contact and fire the uniform created-effect trio
 * when (and only when) a new Contact row is inserted. Returns the same
 * `{ contactId, action }` as `resolveContact`, so callers that branch on
 * `action` are unaffected.
 */
export async function createContact(
	ctx: MutationCtx,
	signal: ResolveSignal,
): Promise<ResolveResult> {
	const result = await resolveContact(ctx, signal);

	if (result.action === 'created') {
		// 1. Keep the denormalized count true across every create path.
		await incrementContactCount(ctx, 1);

		// 2. Run "when a contact is created" automations.
		await ctx.runMutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: result.contactId,
		});

		// 3. Record the first-touch activity, tagged with the create source.
		await recordContactActivity(ctx, {
			literal: 'created',
			contactId: result.contactId,
			metadata: { source: signal.source },
		});

		// 4. Fan out the `contact.created` customer webhook. Email channel only —
		//    the event payload is keyed on an email address, and non-email
		//    channels (sms/whatsapp/phone/generic/chat) have none to report.
		//    Fires once per genuinely-new contact (gated on action === 'created');
		//    import's batched upsert path resolves directly and is intentionally
		//    excluded to avoid a webhook storm on bulk import.
		if (signal.channel === 'email') {
			await scheduleFanout(ctx, {
				literal: 'contact.created',
				input: {
					contactId: result.contactId,
					email: signal.identifier,
					source: signal.source,
					at: Date.now(),
				},
			});
		}
	}

	return result;
}

/**
 * Wire surface, symmetric to resolution's `resolve`. Production single-create
 * callers use the in-process `createContact` above to avoid the `runMutation`
 * round-trip; this `internalMutation` is the cross-runtime / test entry point.
 */
export const create = internalMutation({
	args: {
		channel: channelKindValidator,
		identifier: v.string(),
		source: contactSourceValidator,
		mode: resolveModeValidator,
		contactFields: v.optional(contactFieldsValidator),
	},
	handler: async (ctx, args): Promise<ResolveResult> => {
		return await createContact(ctx, args);
	},
});
