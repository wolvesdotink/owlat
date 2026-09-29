/**
 * Contact edit and strict create — the single write path behind every
 * operator-facing "create a contact" / "edit a contact" entry point.
 *
 * The session mutations (`contacts.create` / `contacts.update`) and their
 * API-key twins (`createForTeam` / `updateForTeam`, behind the public REST API)
 * are auth-plus-call shells over these helpers, so validation, the soft-delete
 * guard, the email identity re-key, `searchableText`, the audit row and the
 * `contact_updated` trigger cannot drift between them again.
 *
 * Not for find-or-create: resolution's `merge` mode keeps its own semantics
 * (an empty value never overwrites) in `contacts/resolution.ts`.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { throwNotFound } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { validateStringLength, normalizeEmail, STRING_LIMITS } from '../lib/inputGuards';
import { buildSearchableText } from '../lib/queryHelpers';
import { createContact } from './creation';
import type { ContactSource } from '../lib/validators/contacts';
import { changeContactEmail } from './resolution';

/** Who the audit row names: a session's user id, or `'api'` for API-key writes. */
export interface ContactWriteActor {
	actorUserId: string;
}

export interface ContactEditFields {
	email?: string;
	firstName?: string;
	lastName?: string;
	timezone?: string;
	language?: string;
}

export interface ContactCreateFields {
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	source?: ContactSource;
}

function validateContactLengths(fields: { email?: string; firstName?: string; lastName?: string }) {
	if (fields.email !== undefined) validateStringLength(fields.email, STRING_LIMITS.NAME, 'Email');
	if (fields.firstName !== undefined)
		validateStringLength(fields.firstName, STRING_LIMITS.NAME, 'First name');
	if (fields.lastName !== undefined)
		validateStringLength(fields.lastName, STRING_LIMITS.NAME, 'Last name');
}

/**
 * Apply an edit to a live contact. Omitted fields are left alone; names are
 * trimmed, and an empty timezone or language clears the field.
 */
export async function applyContactEdit(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	fields: ContactEditFields,
	{ actorUserId }: ContactWriteActor
): Promise<Id<'contacts'>> {
	const contact = await ctx.db.get(contactId);
	if (!contact || contact.deletedAt !== undefined) throwNotFound('Contact');

	validateContactLengths(fields);

	const updates: Partial<Doc<'contacts'>> & { updatedAt: number } = { updatedAt: Date.now() };
	// Which built-in fields actually changed, for the audit row and the
	// `contact_updated` trigger's watched-property list.
	const changedProperties: string[] = [];

	if (fields.email !== undefined) {
		const { email, changed } = await changeContactEmail(ctx, contact, fields.email);
		if (changed) changedProperties.push('email');
		updates.email = email;
	}

	if (fields.firstName !== undefined) {
		const firstName = fields.firstName.trim();
		if (firstName !== (contact.firstName ?? '')) changedProperties.push('firstName');
		updates.firstName = firstName;
	}

	if (fields.lastName !== undefined) {
		const lastName = fields.lastName.trim();
		if (lastName !== (contact.lastName ?? '')) changedProperties.push('lastName');
		updates.lastName = lastName;
	}

	if (fields.timezone !== undefined) {
		if (fields.timezone !== (contact.timezone ?? '')) changedProperties.push('timezone');
		updates.timezone = fields.timezone || undefined;
	}

	if (fields.language !== undefined) {
		if (fields.language !== (contact.language ?? '')) changedProperties.push('language');
		updates.language = fields.language || undefined;
	}

	if (
		fields.email !== undefined ||
		fields.firstName !== undefined ||
		fields.lastName !== undefined
	) {
		updates.searchableText = buildSearchableText(
			updates.email ?? contact.email,
			updates.firstName ?? contact.firstName ?? '',
			updates.lastName ?? contact.lastName ?? ''
		);
	}

	await ctx.db.patch(contactId, updates);

	if (changedProperties.length > 0) {
		await recordAuditLog(ctx, {
			userId: actorUserId,
			action: 'contact.updated',
			resource: 'contact',
			resourceId: contactId,
			details: { changedProperties: changedProperties.join(', ') },
		});
		await ctx.runMutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId,
			changedProperties,
		});
	}

	return contactId;
}

/**
 * Create a contact by email, refusing when a live contact already holds the
 * address. Fires the created-effect bundle (via `createContact`) and writes
 * the `contact.created` audit row.
 */
export async function createContactStrict(
	ctx: MutationCtx,
	fields: ContactCreateFields,
	{ actorUserId }: ContactWriteActor
): Promise<Id<'contacts'>> {
	validateContactLengths(fields);

	const email = normalizeEmail(fields.email);
	const { contactId } = await createContact(ctx, {
		channel: 'email',
		identifier: email,
		source: fields.source ?? 'api',
		mode: 'strict',
		contactFields: {
			firstName: fields.firstName,
			lastName: fields.lastName,
			language: fields.language,
		},
	});

	await recordAuditLog(ctx, {
		userId: actorUserId,
		action: 'contact.created',
		resource: 'contact',
		resourceId: contactId,
		details: { email },
	});

	return contactId;
}
