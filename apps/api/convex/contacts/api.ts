import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createAuthenticatedHandler,
	jsonResponse,
	errorResponse,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiAuth';
import { isValidEmail, isValidConvexId, STRING_LIMITS, safeDecodeURIComponent } from '../lib/inputGuards';
import type { ContactSource } from './resolution';

// Type for the action context
interface ActionContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
}

// Request body types
interface CreateContactBody {
	email: string;
	firstName?: string;
	lastName?: string;
}

interface UpdateContactBody {
	email?: string;
	firstName?: string;
	lastName?: string;
}

// Response types
export interface ContactResponse {
	id: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
	source: ContactSource;
	createdAt: string;
	updatedAt: string;
}

// Contact type from database (exported for testing)
export interface Contact {
	_id: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
	source: ContactSource;
	createdAt: number;
	updatedAt: number;
}

/**
 * Transform a contact from database format to API response format
 */
export function formatContactResponse(contact: Contact): ContactResponse {
	return {
		id: contact._id,
		email: contact.email,
		firstName: contact.firstName ?? null,
		lastName: contact.lastName ?? null,
		source: contact.source,
		createdAt: new Date(contact.createdAt).toISOString(),
		updatedAt: new Date(contact.updatedAt).toISOString(),
	};
}

/**
 * Parse a string as a contact ID or return null.
 * Delegates to the shared Convex-ID validator so this and other entry points
 * (tracking, etc.) accept the same shape — minimum 10 chars, URL-safe base64
 * with hyphens included (older copy was missing `-` and the length floor,
 * which let too-short inputs reach `v.id('contacts')` and throw a 500).
 */
export function isValidContactId(id: string): boolean {
	return isValidConvexId(id);
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
	ctx: Pick<ActionContext, 'runQuery'>,
	ref: { email?: string; id?: string },
	options?: { notFoundMessage?: string }
): Promise<Contact | Response> {
	const email = ref.email?.trim();
	const id = ref.id?.trim();

	let contact: Contact | null = null;
	if (id) {
		if (!isValidContactId(id)) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}
		contact = await ctx.runQuery<Contact | null>(
			internal.contacts.contacts.getInternal,
			{ contactId: id as Id<'contacts'> }
		);
	} else if (email) {
		if (!isValidEmail(email)) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}
		contact = await ctx.runQuery<Contact | null>(
			internal.contacts.contacts.getByEmailForTeam,
			{ email: email.toLowerCase() }
		);
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
	if (!contact || (contact as { deletedAt?: number }).deletedAt !== undefined) {
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
	ctx: Pick<ActionContext, 'runQuery'>,
	idOrEmail: string
): Promise<Contact | Response> {
	return isValidEmail(idOrEmail)
		? resolveContactRef(ctx, { email: idOrEmail })
		: resolveContactRef(ctx, { id: idOrEmail });
}

// ============ HTTP ACTION HANDLERS ============

/**
 * POST /api/v1/contacts - Create a new contact
 */
export const createContact = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Parse request body
		let body: CreateContactBody;
		try {
			body = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}

		// Validate required fields
		if (!body.email) {
			return errorResponse('invalid_input', 'Email is required');
		}

		if (typeof body.email !== 'string') {
			return errorResponse('invalid_input', 'Email must be a string');
		}

		if (!isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		// Validate optional fields
		if (body.firstName !== undefined && typeof body.firstName !== 'string') {
			return errorResponse('invalid_input', 'firstName must be a string');
		}

		if (body.firstName && body.firstName.length > STRING_LIMITS.NAME) {
			return errorResponse('invalid_input', `firstName must be at most ${STRING_LIMITS.NAME} characters`);
		}

		if (body.lastName !== undefined && typeof body.lastName !== 'string') {
			return errorResponse('invalid_input', 'lastName must be a string');
		}

		if (body.lastName && body.lastName.length > STRING_LIMITS.NAME) {
			return errorResponse('invalid_input', `lastName must be at most ${STRING_LIMITS.NAME} characters`);
		}

		// Create the contact (mutation handles duplicate check atomically)
		try {
			const contactId = await ctx.runMutation<Id<'contacts'>>(
				internal.contacts.contacts.createForTeam,
				{
					email: body.email,
					firstName: body.firstName,
					lastName: body.lastName,
					source: 'api' as const,
				}
			);

			// Fetch the created contact
			const contact = await ctx.runQuery<Contact | null>(
				internal.contacts.contacts.getInternal,
				{ contactId }
			);

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
			const message = error instanceof Error ? error.message : 'Failed to create contact';
			// Handle duplicate email error from mutation
			if (message.includes('already exists')) {
				return errorResponse('already_exists', 'A contact with this email already exists');
			}
			return errorResponse('invalid_input', message);
		}
	}
);

/**
 * GET /api/v1/contacts/{id} - Get a contact by ID or email
 * The {id} parameter can be either a contact ID or an email address
 */
export const getContact = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:read', request.headers.get('Origin'));
		if (denied) return denied;
		// Extract ID from URL path
		const url = new URL(request.url);
		const pathParts = url.pathname.split('/');
		const idOrEmail = pathParts[pathParts.length - 1];

		if (!idOrEmail) {
			return errorResponse('invalid_input', 'Contact ID or email is required');
		}

		// Decode URL-encoded value (for emails with special characters).
		// Malformed percent-encoding must surface as a 400, not a generic 500.
		const decodedIdOrEmail = safeDecodeURIComponent(idOrEmail);
		if (decodedIdOrEmail === null) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}

		const resolved = await resolveContactFromIdOrEmail(ctx, decodedIdOrEmail);
		if (resolved instanceof Response) return resolved;
		const contact = resolved;

		// Don't expose soft-deleted contacts via the public API — a contact in
		// the post-erasure retention window is logically gone until the
		// hard-delete cron removes it.
		if ((contact as { deletedAt?: number }).deletedAt !== undefined) {
			return errorResponse('not_found', 'Contact not found');
		}

		return jsonResponse({
			data: formatContactResponse(contact),
		});
	}
);

/**
 * PUT /api/v1/contacts/{id} - Update a contact
 */
export const updateContact = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Extract ID from URL path
		const url = new URL(request.url);
		const pathParts = url.pathname.split('/');
		const idOrEmail = pathParts[pathParts.length - 1];

		if (!idOrEmail) {
			return errorResponse('invalid_input', 'Contact ID or email is required');
		}

		// Decode URL-encoded value
		const decodedIdOrEmail = decodeURIComponent(idOrEmail);

		// Parse request body
		let body: UpdateContactBody;
		try {
			body = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}

		// Validate update fields
		if (body.email !== undefined) {
			if (typeof body.email !== 'string') {
				return errorResponse('invalid_input', 'email must be a string');
			}
			if (!isValidEmail(body.email)) {
				return errorResponse('invalid_input', 'Invalid email format');
			}
		}

		if (body.firstName !== undefined && typeof body.firstName !== 'string') {
			return errorResponse('invalid_input', 'firstName must be a string');
		}

		if (body.lastName !== undefined && typeof body.lastName !== 'string') {
			return errorResponse('invalid_input', 'lastName must be a string');
		}

		// Find the contact
		const resolved = await resolveContactFromIdOrEmail(ctx, decodedIdOrEmail);
		if (resolved instanceof Response) return resolved;
		const contactId = resolved._id;

		// Update the contact
		try {
			await ctx.runMutation<Id<'contacts'>>(
				internal.contacts.contacts.updateForTeam,
				{
					contactId,
					email: body.email,
					firstName: body.firstName,
					lastName: body.lastName,
				}
			);

			// Fetch the updated contact
			const updatedContact = await ctx.runQuery<Contact | null>(
				internal.contacts.contacts.getInternal,
				{ contactId }
			);

			if (!updatedContact) {
				return errorResponse('internal', 'Failed to fetch updated contact');
			}

			return jsonResponse({
				data: formatContactResponse(updatedContact),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to update contact';
			// Check for duplicate email error
			if (message.includes('already exists')) {
				return errorResponse('already_exists', message);
			}
			return errorResponse('invalid_input', message);
		}
	}
);

/**
 * DELETE /api/v1/contacts/{id} - Delete a contact
 */
export const deleteContact = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Extract ID from URL path
		const url = new URL(request.url);
		const pathParts = url.pathname.split('/');
		const idOrEmail = pathParts[pathParts.length - 1];

		if (!idOrEmail) {
			return errorResponse('invalid_input', 'Contact ID or email is required');
		}

		// Decode URL-encoded value
		const decodedIdOrEmail = decodeURIComponent(idOrEmail);

		// Find the contact
		const resolved = await resolveContactFromIdOrEmail(ctx, decodedIdOrEmail);
		if (resolved instanceof Response) return resolved;
		const contactId = resolved._id;

		// Delete the contact
		try {
			await ctx.runMutation<undefined>(
				internal.contacts.contacts.removeForTeam,
				{ contactId }
			);

			return jsonResponse(
				{
					data: {
						id: contactId,
						deleted: true,
					},
				},
				200
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to delete contact';
			return errorResponse('invalid_input', message);
		}
	}
);

/**
 * GET /api/v1/contacts - List contacts with cursor-based pagination and search.
 *
 * Cursor-paginated (ADR-0037): pass `limit` (max 100) and an opaque `cursor`
 * from the previous response's `pagination.cursor`. `pagination.isDone` is true
 * once the final page has been returned. Search is relevance-ordered and
 * genuinely multi-page. There is no row ceiling — every contact is reachable.
 */
export const listContacts = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'contacts:read', request.headers.get('Origin'));
		if (denied) return denied;
		// Parse query parameters
		const url = new URL(request.url);
		const limit = Math.min(
			parseInt(url.searchParams.get('limit') || '25', 10),
			100 // Max 100 per page
		);
		const cursor = url.searchParams.get('cursor');
		const search = url.searchParams.get('search') || undefined;

		// Validate pagination
		if (isNaN(limit) || limit < 1) {
			return errorResponse('invalid_input', 'Invalid limit');
		}

		// Query contacts
		const result = await ctx.runQuery<{
			contacts: Contact[];
			isDone: boolean;
			continueCursor: string;
			totalCount: number;
		}>(
			internal.contacts.contacts.listByTeam,
			{
				search,
				paginationOpts: { numItems: limit, cursor: cursor ?? null },
			}
		);

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
