import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { extractOperationError } from '@owlat/shared/operationError';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import {
	jsonResponse,
	errorResponse,
	lastPathSegment,
	type PathSegment,
} from '../auth/apiResponses';
import { isValidEmail, isValidConvexId, STRING_LIMITS } from '../lib/inputGuards';
import type { Contact as ContactResponse } from '@owlat/public-contract';
import {
	createContactRequestSchema,
	decodeRequest,
	readListQuery,
	updateContactRequestSchema,
} from '@owlat/public-contract/schemas';

/**
 * A create or edit refused because the email belongs to another contact. The
 * contact writers raise that as an `already_exists` Operation error
 * (`contacts/resolution.ts`); its message names the address, so only the
 * category is read.
 */
function isDuplicateContact(error: unknown): boolean {
	return extractOperationError(error)?.category === 'already_exists';
}

/** The contact fields the v1 response exposes (exported for testing). */
export type Contact = Pick<
	Doc<'contacts'>,
	'_id' | 'email' | 'firstName' | 'lastName' | 'source' | 'createdAt' | 'updatedAt'
>;

/**
 * Transform a contact from database format to API response format. A contact
 * that arrived through a non-email channel has no email; the v1 contract keeps
 * `email` a string, so it is emitted as `''`.
 */
export function formatContactResponse(contact: Contact): ContactResponse {
	return {
		id: contact._id,
		email: contact.email ?? '',
		firstName: contact.firstName ?? null,
		lastName: contact.lastName ?? null,
		source: contact.source,
		createdAt: new Date(contact.createdAt).toISOString(),
		updatedAt: new Date(contact.updatedAt).toISOString(),
	};
}

/**
 * Resolve a contact from an `{ email?, id? }` request reference.
 *
 * Centralises the resolve-or-error path shared by the contacts and topics
 * HTTP APIs: validate that *some* ref was supplied, look it up by ID or by
 * (lower-cased, trimmed) email, and surface the not-found case. On success it
 * returns the `Contact`; on any failure it returns the `Response` the handler
 * should return directly.
 *
 * `notFoundMessage` lets callers keep their existing copy (e.g. the topics API
 * echoes the email back in its 404). Soft-delete filtering and any
 * create-on-missing behaviour stay in the caller.
 */
export async function resolveContactRef(
	ctx: Pick<ActionCtx, 'runQuery'>,
	ref: { email?: string; id?: string },
	options?: { notFoundMessage?: string }
): Promise<Doc<'contacts'> | Response> {
	const email = ref.email?.trim();
	const id = ref.id?.trim();

	let contact: Doc<'contacts'> | null = null;
	if (id) {
		// The shared Convex-ID shape check: an under-length or foreign-alphabet
		// value must be a 400 here, never reach `v.id('contacts')` as a 500.
		if (!isValidConvexId(id)) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}
		contact = await ctx.runQuery(internal.contacts.contacts.getInternal, {
			contactId: id as Id<'contacts'>,
		});
	} else if (email) {
		if (!isValidEmail(email)) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}
		contact = await ctx.runQuery(internal.contacts.contacts.getByEmailForTeam, {
			email: email.toLowerCase(),
		});
	} else {
		return errorResponse('invalid_input', 'Contact ID or email is required');
	}

	// Treat soft-deleted (GDPR-erased) contacts as non-existent. The contacts
	// row survives the retention window with email/firstName/lastName intact and
	// stays in the `by_email` index, so without this guard the update/delete/
	// topics handlers would re-expose erased PII, re-subscribe the gravestone, or
	// hard-delete it a second time (double-decrementing the count). `getContact`
	// (GET) already applies the same check; centralizing it here makes every
	// id/email lookup that flows through `resolveContactRef` honor the documented
	// "all lookups MUST filter deletedAt === undefined" contract.
	if (!contact || contact.deletedAt !== undefined) {
		return errorResponse('not_found', options?.notFoundMessage ?? 'Contact not found');
	}

	return contact;
}

/**
 * Resolve a contact from a single string that is either an email or an ID,
 * the shape used on the contacts `/{id}` routes. Branches on `isValidEmail`
 * first (so an email-looking value is never treated as an ID) and otherwise
 * defers the ID-shape check to {@link resolveContactRef}.
 */
function resolveContactFromIdOrEmail(
	ctx: Pick<ActionCtx, 'runQuery'>,
	idOrEmail: string
): Promise<Doc<'contacts'> | Response> {
	return isValidEmail(idOrEmail)
		? resolveContactRef(ctx, { email: idOrEmail })
		: resolveContactRef(ctx, { id: idOrEmail });
}

/**
 * The contact `{id}` / `{emailOrId}` path segment, or the 400 to return: a
 * missing segment and a malformed percent-encoding each keep their own copy.
 * Shared by the contacts `/{id}` routes and the topics removal route.
 */
export function contactRefFromPath(segment: PathSegment): string | Response {
	if (segment.ok) return segment.value;
	return segment.reason === 'missing'
		? errorResponse('invalid_input', 'Contact ID or email is required')
		: errorResponse('invalid_input', 'Invalid contact ID or email format');
}

/**
 * Length caps for the optional name fields, shared by POST and PUT so both
 * answer with the specific 400 before the mutation's own bound rejects. The
 * contract's schema has already checked that each one is a string.
 */
function validateNameFields(body: { firstName?: string; lastName?: string }): Response | null {
	for (const field of ['firstName', 'lastName'] as const) {
		const value = body[field];
		if (value === undefined) continue;
		if (value.length > STRING_LIMITS.NAME) {
			return errorResponse(
				'invalid_input',
				`${field} must be at most ${STRING_LIMITS.NAME} characters`
			);
		}
	}
	return null;
}

// ============ HTTP ACTION HANDLERS ============

/**
 * POST /api/v1/contacts - Create a new contact
 */
export const createContact = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}
		const decoded = decodeRequest(createContactRequestSchema, raw);
		if (!decoded.ok) return errorResponse('invalid_input', decoded.message);
		const body = decoded.value;
		if (!isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		const nameError = validateNameFields(body);
		if (nameError) return nameError;

		// Create the contact (mutation handles duplicate check atomically)
		try {
			const contactId = await ctx.runMutation(internal.contacts.contacts.createForTeam, {
				email: body.email,
				firstName: body.firstName,
				lastName: body.lastName,
				source: 'api' as const,
			});

			// Fetch the created contact
			const contact = await ctx.runQuery(internal.contacts.contacts.getInternal, {
				contactId,
			});

			if (!contact) {
				return errorResponse('internal', 'Failed to create contact');
			}

			return jsonResponse(
				{
					data: formatContactResponse(contact),
				},
				201
			);
		} catch (error) {
			// Locked error envelope: classify by the thrown category, never by the
			// wording, and never echo the raw message back — only fixed strings ship.
			if (isDuplicateContact(error)) {
				return errorResponse('already_exists', 'A contact with this email already exists');
			}
			return errorResponse('invalid_input', 'Failed to create contact');
		}
	}
);

/**
 * GET /api/v1/contacts/{id} - Get a contact by ID or email
 * The {id} parameter can be either a contact ID or an email address
 */
export const getContact = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:read', request.headers.get('Origin'));
		if (denied) return denied;
		// The `{id}` segment (an ID or a URL-encoded email).
		const idOrEmail = contactRefFromPath(lastPathSegment(request));
		if (idOrEmail instanceof Response) return idOrEmail;

		// resolveContactRef already treats soft-deleted contacts as not found.
		const contact = await resolveContactFromIdOrEmail(ctx, idOrEmail);
		if (contact instanceof Response) return contact;

		return jsonResponse({
			data: formatContactResponse(contact),
		});
	}
);

/**
 * PUT /api/v1/contacts/{id} - Update a contact
 */
export const updateContact = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		// The `{id}` segment (an ID or a URL-encoded email).
		const idOrEmail = contactRefFromPath(lastPathSegment(request));
		if (idOrEmail instanceof Response) return idOrEmail;

		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}
		const decoded = decodeRequest(updateContactRequestSchema, raw);
		if (!decoded.ok) return errorResponse('invalid_input', decoded.message);
		const body = decoded.value;
		if (body.email !== undefined && !isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		const nameError = validateNameFields(body);
		if (nameError) return nameError;

		// Find the contact
		const resolved = await resolveContactFromIdOrEmail(ctx, idOrEmail);
		if (resolved instanceof Response) return resolved;
		const contactId = resolved._id;

		// Update the contact
		try {
			await ctx.runMutation(internal.contacts.contacts.updateForTeam, {
				contactId,
				email: body.email,
				firstName: body.firstName,
				lastName: body.lastName,
			});

			// Fetch the updated contact
			const updatedContact = await ctx.runQuery(internal.contacts.contacts.getInternal, {
				contactId,
			});

			if (!updatedContact) {
				return errorResponse('internal', 'Failed to fetch updated contact');
			}

			return jsonResponse({
				data: formatContactResponse(updatedContact),
			});
		} catch (error) {
			// Locked error envelope — classify by category, never echo the raw message.
			if (isDuplicateContact(error)) {
				return errorResponse('already_exists', 'A contact with this email already exists');
			}
			return errorResponse('invalid_input', 'Failed to update contact');
		}
	}
);

/**
 * DELETE /api/v1/contacts/{id} - Delete a contact
 */
export const deleteContact = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		// The `{id}` segment (an ID or a URL-encoded email).
		const idOrEmail = contactRefFromPath(lastPathSegment(request));
		if (idOrEmail instanceof Response) return idOrEmail;

		// Find the contact
		const resolved = await resolveContactFromIdOrEmail(ctx, idOrEmail);
		if (resolved instanceof Response) return resolved;
		const contactId = resolved._id;

		// Delete the contact
		try {
			await ctx.runMutation(internal.contacts.contacts.removeForTeam, { contactId });

			return jsonResponse(
				{
					data: {
						id: contactId,
						deleted: true,
					},
				},
				200
			);
		} catch {
			// Locked error envelope — do not echo the raw internal error message.
			return errorResponse('invalid_input', 'Failed to delete contact');
		}
	}
);

/**
 * GET /api/v1/contacts - List contacts with cursor-based pagination and search.
 *
 * Cursor-paginated: pass `limit` (max 100) and an opaque `cursor`
 * from the previous response's `pagination.cursor`. `pagination.isDone` is true
 * once the final page has been returned. Search is relevance-ordered and
 * genuinely multi-page. There is no row ceiling — every contact is reachable.
 */
export const listContacts = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:read', request.headers.get('Origin'));
		if (denied) return denied;
		const query = readListQuery(new URL(request.url).searchParams);
		if (!query.ok) return errorResponse('invalid_input', query.message);
		const { limit, cursor, search } = query.value;

		// Query contacts
		const result = await ctx.runQuery(internal.contacts.contacts.listByTeam, {
			search,
			paginationOpts: { numItems: limit, cursor },
		});

		return jsonResponse({
			data: result.contacts.map(formatContactResponse),
			pagination: {
				limit,
				totalItems: result.totalCount,
				cursor: result.isDone ? null : result.continueCursor,
				isDone: result.isDone,
			},
		});
	}
);
