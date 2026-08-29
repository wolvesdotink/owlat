/**
 * The public REST surface — everything under `/api/v1`, plus its CORS
 * preflights and the unauthenticated health check.
 *
 * Split out of the root `http.ts` for the ~500 LOC ratchet, following the
 * `registerSampleDataRoutes` precedent: `http.ts` stays the ONE place that says
 * which route families exist and in what order (BetterAuth must register last),
 * while each family owns its own paths.
 *
 * Every path below is WRITTEN OUT rather than assembled, for the same reason
 * the webhook routes in `http.ts` are: these URLs live in customers' integration
 * code, and a route that can move itself is an API that can break without
 * anyone editing a file that mentions it.
 */

import type { HttpRouter } from 'convex/server';
import { handleCors, healthCheck } from './auth/apiAuth';
import {
	createContact,
	getContact,
	updateContact,
	deleteContact,
	listContacts,
} from './contacts/api';
import { sendEvent } from './eventsApi';
import { sendTransactional } from './transactional/api';
import { addContactToTopic, removeContactFromTopic } from './topics/apiHttp';

export function registerPublicApiRoutes(http: HttpRouter): void {
	// API health check (no authentication required)
	http.route({
		path: '/api/v1/health',
		method: 'GET',
		handler: healthCheck,
	});

	// CORS preflight handlers for API routes
	// Contacts API
	http.route({
		path: '/api/v1/contacts',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		pathPrefix: '/api/v1/contacts/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Events API
	http.route({
		path: '/api/v1/events',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Transactional API
	http.route({
		path: '/api/v1/transactional',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Topics API (single prefix covers all topic sub-paths)
	http.route({
		pathPrefix: '/api/v1/topics/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// ============ CONTACTS API ENDPOINTS ============

	// GET /api/v1/contacts - List contacts
	http.route({
		path: '/api/v1/contacts',
		method: 'GET',
		handler: listContacts,
	});

	// POST /api/v1/contacts - Create contact
	http.route({
		path: '/api/v1/contacts',
		method: 'POST',
		handler: createContact,
	});

	// GET /api/v1/contacts/{id} - Get contact by ID or email
	http.route({
		pathPrefix: '/api/v1/contacts/',
		method: 'GET',
		handler: getContact,
	});

	// PUT /api/v1/contacts/{id} - Update contact
	http.route({
		pathPrefix: '/api/v1/contacts/',
		method: 'PUT',
		handler: updateContact,
	});

	// DELETE /api/v1/contacts/{id} - Delete contact
	http.route({
		pathPrefix: '/api/v1/contacts/',
		method: 'DELETE',
		handler: deleteContact,
	});

	// ============ EVENTS API ENDPOINTS ============

	// POST /api/v1/events - Send event to trigger automations
	http.route({
		path: '/api/v1/events',
		method: 'POST',
		handler: sendEvent,
	});

	// ============ TRANSACTIONAL API ENDPOINTS ============

	// POST /api/v1/transactional - Send transactional email
	http.route({
		path: '/api/v1/transactional',
		method: 'POST',
		handler: sendTransactional,
	});

	// ============ TOPICS API ENDPOINTS ============

	// POST /api/v1/topics/{topicId}/contacts - Add contact to topic
	http.route({
		pathPrefix: '/api/v1/topics/',
		method: 'POST',
		handler: addContactToTopic,
	});

	// DELETE /api/v1/topics/{topicId}/contacts/{emailOrId} - Remove contact from topic
	http.route({
		pathPrefix: '/api/v1/topics/',
		method: 'DELETE',
		handler: removeContactFromTopic,
	});
}
