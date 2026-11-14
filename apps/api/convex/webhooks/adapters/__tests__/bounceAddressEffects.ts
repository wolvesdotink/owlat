import { readFileSync } from 'node:fs';
import { reduceBounced, type EmailSendDoc } from '../../../delivery/sendLifecycle/reducers';
import type { Doc } from '../../../_generated/dataModel';
import type { InboundEvent } from '../../types';

/** A relay's documented bounce payloads, by case name (`apps/api/fixtures/provider-bounces`). */
export function readBounceFixtures(relay: 'ses' | 'resend' | 'emailit'): Record<string, unknown> {
	return JSON.parse(
		readFileSync(
			new URL(`../../../../fixtures/provider-bounces/${relay}.json`, import.meta.url),
			'utf8'
		)
	) as Record<string, unknown>;
}

/**
 * What the bounce does to the address once it reaches the Send lifecycle, for
 * a contact one soft bounce short of suppression.
 */
export function addressEffects(event: InboundEvent | null): string[] {
	if (event?.kind !== 'email.bounced') throw new Error('expected an email.bounced event');
	const send = {
		_id: 'send-1',
		_creationTime: 0,
		campaignId: 'campaign-1',
		contactId: 'contact-1',
		contactEmail: 'recipient@example.com',
		status: 'sent',
	} as unknown as EmailSendDoc;
	const contact = {
		_id: 'contact-1',
		_creationTime: 0,
		email: 'recipient@example.com',
		softBounceCount: 4,
	} as unknown as Doc<'contacts'>;
	const { effects } = reduceBounced(
		send,
		{
			to: 'bounced',
			at: event.at,
			bounceType: event.bounceType,
			...(event.bounceCause ? { bounceCause: event.bounceCause } : {}),
		},
		{ kind: 'campaign', id: send._id },
		'recipient@example.com',
		'example.org',
		contact
	);
	return effects
		.map((effect) => effect.kind)
		.filter((kind) => kind === 'blocklist_insert' || kind === 'contact_soft_bounce_count');
}
