import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import {
	jsonResponse,
	errorResponse,
	pathSegmentAfter,
	type PathSegment,
} from '../auth/apiResponses';
import { isValidEmail, isValidConvexId } from '../lib/inputGuards';
import { contactRefFromPath, resolveContactRef } from '../contacts/api';

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

/**
 * The `{topicId}` segment of `/api/v1/topics/{topicId}/...`, or the 400 to
 * return. The ID-shape check is the shared Convex-ID validator, so an
 * under-length value is a 400 rather than a `v.id('topics')` 500.
 */
function topicIdFromPath(segment: PathSegment): Id<'topics'> | Response {
	if (!segment.ok && segment.reason === 'missing') {
		return errorResponse('invalid_input', 'Topic ID is required');
	}
	if (!segment.ok || !isValidConvexId(segment.value)) {
		return errorResponse('invalid_input', 'Invalid topic ID format');
	}
	return segment.value as Id<'topics'>;
}

/**
 * POST /api/v1/topics/{topicId}/contacts - Add contact to a topic
 */
export const addContactToTopic = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'topics:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Path: /api/v1/topics/{topicId}/contacts
		const topicId = topicIdFromPath(pathSegmentAfter(request, 'topics'));
		if (topicId instanceof Response) return topicId;

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
		if (body.contactId && !isValidConvexId(body.contactId)) {
			return errorResponse('invalid_input', 'Invalid contactId format');
		}

		// Check if the topic exists and belongs to the organization
		const topic = await ctx.runQuery(internal.topics.topics.getInternal, { topicId });

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
			const result = await ctx.runMutation(internal.topics.topics.addContactInternal, {
				topicId,
				contactId,
				siteUrl: getOptional('SITE_URL'),
			});

			const response: AddContactResponse = {
				success: true,
				contactId: contactId,
				topicId: topicId,
				doiStatus: result.doiStatus,
			};

			return jsonResponse({ data: response }, 201);
		} catch {
			// Locked error envelope — do not echo the raw internal error message.
			return errorResponse('invalid_input', 'Failed to add contact to topic');
		}
	}
);

/**
 * DELETE /api/v1/topics/{topicId}/contacts/{emailOrId} - Remove contact from a topic
 */
export const removeContactFromTopic = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'topics:write', request.headers.get('Origin'));
		if (denied) return denied;
		// Path: /api/v1/topics/{topicId}/contacts/{emailOrId}
		const topicId = topicIdFromPath(pathSegmentAfter(request, 'topics'));
		if (topicId instanceof Response) return topicId;

		const emailOrId = contactRefFromPath(pathSegmentAfter(request, 'contacts'));
		if (emailOrId instanceof Response) return emailOrId;

		// Check if the topic exists and belongs to the organization
		const topic = await ctx.runQuery(internal.topics.topics.getInternal, { topicId });

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
		const topicsForContact = await ctx.runQuery(
			internal.topics.topics.getTopicsForContactInternal,
			{ contactId }
		);

		const isInTopic = topicsForContact.some((topicDoc) => topicDoc._id === topicId);

		// Remove contact from topic (this is idempotent, won't error if not a member)
		try {
			await ctx.runMutation(internal.topics.topics.removeContactInternal, {
				topicId,
				contactId,
			});

			const response: RemoveContactResponse = {
				success: true,
				removed: isInTopic,
			};

			return jsonResponse({ data: response });
		} catch {
			// Locked error envelope — do not echo the raw internal error message.
			return errorResponse('invalid_input', 'Failed to remove contact from topic');
		}
	}
);
