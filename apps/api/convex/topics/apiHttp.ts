import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getOptional } from '../lib/env';
import {
	createAuthenticatedHandler,
	jsonResponse,
	errorResponse,
	methodNotAllowed,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiAuth';
import { isValidEmail, isValidConvexId, safeDecodeURIComponent } from '../lib/inputGuards';
import { resolveContactRef } from '../contacts/api';

// Type for the action context
interface ActionContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
}

// Request body types
interface AddContactBody {
	email?: string;
	contactId?: string;
}

// Response types
interface AddContactResponse {
	success: boolean;
	contactId: string;
	topicId: string;
	doiStatus: 'not_required' | 'pending' | 'confirmed';
}

interface RemoveContactResponse {
	success: boolean;
	removed: boolean;
}

// Database types
interface Topic {
	_id: Id<'topics'>;
	name: string;
	description?: string;
	requireDoubleOptIn?: boolean;
	createdAt: number;
}

/**
 * Parse a string as a Convex document ID. Delegates to the shared validator
 * so under-length or hyphen-containing inputs are handled consistently with
 * the rest of the backend (lib/validation.ts:isValidConvexId). Module-private:
 * the two handlers below are the only callers.
 */
function isValidId(id: string): boolean {
	return isValidConvexId(id);
}

/**
 * POST /api/v1/topics/{topicId}/contacts - Add contact to a topic
 */
export const addContactToTopic = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'topics:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Extract topicId from URL path
		const url = new URL(request.url);
		const pathParts = url.pathname.split('/');
		// Path: /api/v1/topics/{topicId}/contacts
		const topicsIndex = pathParts.indexOf('topics');
		if (topicsIndex === -1 || topicsIndex + 1 >= pathParts.length) {
			return errorResponse('invalid_input', 'Topic ID is required');
		}
		const topicId = pathParts[topicsIndex + 1];

		if (!topicId || !isValidId(topicId)) {
			return errorResponse('invalid_input', 'Invalid topic ID format');
		}

		// Parse request body
		let body: AddContactBody;
		try {
			body = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}

		// Validate that either email or contactId is provided
		if (!body.email && !body.contactId) {
			return errorResponse('invalid_input', 'Either email or contactId is required');
		}

		// Validate email format if provided
		if (body.email && !isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		// Validate contactId format if provided
		if (body.contactId && !isValidId(body.contactId)) {
			return errorResponse('invalid_input', 'Invalid contactId format');
		}

		// Check if the topic exists and belongs to the organization
		const topic = await ctx.runQuery<Topic | null>(
			internal.topics.topics.getInternal,
			{ topicId: topicId as Id<'topics'> }
		);

		if (!topic) {
			return errorResponse('not_found', 'Topic not found');
		}

		// Find or validate the contact. Format validation already happened above
		// (with topic-specific messages); resolveContactRef handles the shared
		// lookup + not-found path. The email 404 echoes the address back.
		const resolved = await resolveContactRef(
			ctx,
			{ email: body.email, id: body.contactId },
			body.contactId
				? undefined
				: { notFoundMessage: `Contact with email "${body.email}" not found` }
		);
		if (resolved instanceof Response) return resolved;
		const contactId: Id<'contacts'> = resolved._id;

		// Add contact to topic
		try {
			const result = await ctx.runMutation<{
				membershipId: Id<'contactTopics'>;
				doiStatus: 'not_required' | 'pending' | 'confirmed';
			}>(
				internal.topics.topics.addContactInternal,
				{
					topicId: topicId as Id<'topics'>,
					contactId,
					siteUrl: getOptional('SITE_URL'),
				}
			);

			const response: AddContactResponse = {
				success: true,
				contactId: contactId,
				topicId: topicId,
				doiStatus: result.doiStatus,
			};

			return jsonResponse({ data: response }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to add contact to topic';
			return errorResponse('invalid_input', message);
		}
	}
);

/**
 * DELETE /api/v1/topics/{topicId}/contacts/{emailOrId} - Remove contact from a topic
 */
export const removeContactFromTopic = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'topics:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Extract topicId and emailOrId from URL path
		const url = new URL(request.url);
		const pathParts = url.pathname.split('/');
		// Path: /api/v1/topics/{topicId}/contacts/{emailOrId}
		const topicsIndex = pathParts.indexOf('topics');
		if (topicsIndex === -1 || topicsIndex + 1 >= pathParts.length) {
			return errorResponse('invalid_input', 'Topic ID is required');
		}
		const topicId = pathParts[topicsIndex + 1];

		const contactsIndex = pathParts.indexOf('contacts', topicsIndex);
		if (contactsIndex === -1 || contactsIndex + 1 >= pathParts.length) {
			return errorResponse('invalid_input', 'Contact ID or email is required');
		}
		const emailOrId = safeDecodeURIComponent(pathParts[contactsIndex + 1] || '');

		if (!topicId || !isValidId(topicId)) {
			return errorResponse('invalid_input', 'Invalid topic ID format');
		}

		if (emailOrId === null) {
			return errorResponse('invalid_input', 'Invalid contact ID or email format');
		}
		if (!emailOrId) {
			return errorResponse('invalid_input', 'Contact ID or email is required');
		}

		// Check if the topic exists and belongs to the organization
		const topic = await ctx.runQuery<Topic | null>(
			internal.topics.topics.getInternal,
			{ topicId: topicId as Id<'topics'> }
		);

		if (!topic) {
			return errorResponse('not_found', 'Topic not found');
		}

		// Find the contact by email or ID. resolveContactRef branches on the
		// same email-vs-ID shape; the email 404 echoes the address back.
		const isEmail = isValidEmail(emailOrId);
		const resolved = await resolveContactRef(
			ctx,
			isEmail ? { email: emailOrId } : { id: emailOrId },
			isEmail ? { notFoundMessage: `Contact with email "${emailOrId}" not found` } : undefined
		);
		if (resolved instanceof Response) return resolved;
		const contactId: Id<'contacts'> = resolved._id;

		// Check if the contact is actually in the topic before removing.
		// getTopicsForContactInternal returns the TOPIC docs the contact belongs
		// to (each keyed by `_id`), not contactTopics membership rows — so match
		// on the topic's `_id`. (The previous `m.topicId` was always undefined,
		// so `removed` was always reported false even on a real unsubscribe.)
		const topicsForContact = await ctx.runQuery<Array<{ _id: Id<'topics'> }>>(
			internal.topics.topics.getTopicsForContactInternal,
			{ contactId }
		);

		const isInTopic = topicsForContact.some(
			(topicDoc) => topicDoc._id === (topicId as Id<'topics'>)
		);

		// Remove contact from topic (this is idempotent, won't error if not a member)
		try {
			await ctx.runMutation<undefined>(
				internal.topics.topics.removeContactInternal,
				{
					topicId: topicId as Id<'topics'>,
					contactId,
				}
			);

			const response: RemoveContactResponse = {
				success: true,
				removed: isInTopic,
			};

			return jsonResponse({ data: response });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to remove contact from topic';
			return errorResponse('invalid_input', message);
		}
	}
);

/**
 * Handle unsupported methods for topic contacts collection endpoint
 */
export const topicContactsCollection = httpAction(async (_, request) => {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				'Access-Control-Max-Age': '86400',
			},
		});
	}

	return methodNotAllowed(`Method ${request.method} not allowed`);
});
