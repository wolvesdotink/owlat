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
import { handleCors, healthCheck } from '../auth/apiAuthHttp';
import {
	createContact,
	getContact,
	updateContact,
	deleteContact,
	listContacts,
} from '../contacts/api';
import { sendEvent } from './events';
import { sendTransactional } from '../transactional/api';
import { getTransactionalSend, listTransactionalSends } from '../transactional/sendStatusHttp';
import { addContactToTopic, listTopics, removeContactFromTopic } from '../topics/apiHttp';
import { getStatus } from './statusHttp';
import { listDomains } from './domainsHttp';
import { verifyDomain } from './domainCheckHttp';
import { getLimits } from './limitsHttp';
import { getOpenApiDocument } from './openApiHttp';
import { getBlockSchema } from './blockSchemaHttp';
import {
	createTransactionalEmail,
	getTransactionalEmail,
	listTransactionalEmails,
	putTransactionalEmail,
	transitionTransactionalEmail,
} from './transactionalEmailsHttp';
import {
	createSavedBlock,
	getSavedBlock,
	listSavedBlocks,
	updateSavedBlock,
} from './savedBlocksHttp';
import { renderEmail } from './renderHttp';

export function registerPublicApiRoutes(http: HttpRouter): void {
	// API health check (no authentication required)
	http.route({
		path: '/api/v1/health',
		method: 'GET',
		handler: healthCheck,
	});

	// The probe answers its own preflight: `handleCors` resolves the
	// credentialed allow-list and would fail closed on an unconfigured
	// deployment, which is the case the probe exists to report on.
	http.route({
		path: '/api/v1/health',
		method: 'OPTIONS',
		handler: healthCheck,
	});

	// This instance's OpenAPI document (no authentication required). It
	// answers its own preflight for the same reason the probe does.
	http.route({
		path: '/api/v1/openapi.json',
		method: 'GET',
		handler: getOpenApiDocument,
	});

	http.route({
		path: '/api/v1/openapi.json',
		method: 'OPTIONS',
		handler: getOpenApiDocument,
	});

	// The JSON Schema of block content (no authentication required), next to
	// the OpenAPI document and answering its own preflight the same way.
	http.route({
		path: '/api/v1/schemas/blocks.json',
		method: 'GET',
		handler: getBlockSchema,
	});

	http.route({
		path: '/api/v1/schemas/blocks.json',
		method: 'OPTIONS',
		handler: getBlockSchema,
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

	http.route({
		pathPrefix: '/api/v1/transactional/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Transactional emails and saved blocks (templates)
	http.route({
		path: '/api/v1/transactional-emails',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		pathPrefix: '/api/v1/transactional-emails/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		path: '/api/v1/saved-blocks',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		pathPrefix: '/api/v1/saved-blocks/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		path: '/api/v1/render',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Status API
	http.route({
		path: '/api/v1/status',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Domains API
	http.route({
		path: '/api/v1/domains',
		method: 'OPTIONS',
		handler: handleCors,
	});

	http.route({
		pathPrefix: '/api/v1/domains/',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Limits API
	http.route({
		path: '/api/v1/limits',
		method: 'OPTIONS',
		handler: handleCors,
	});

	// Topics API: the list, and a single prefix for all topic sub-paths
	http.route({
		path: '/api/v1/topics',
		method: 'OPTIONS',
		handler: handleCors,
	});

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

	// GET /api/v1/transactional - List sends, by recipient, status or window
	http.route({
		path: '/api/v1/transactional',
		method: 'GET',
		handler: listTransactionalSends,
	});

	// GET /api/v1/transactional/{sendId} - Delivery status of one send
	http.route({
		pathPrefix: '/api/v1/transactional/',
		method: 'GET',
		handler: getTransactionalSend,
	});

	// ============ TRANSACTIONAL EMAIL (TEMPLATE) ENDPOINTS ============

	// GET /api/v1/transactional-emails - List transactional emails
	http.route({
		path: '/api/v1/transactional-emails',
		method: 'GET',
		handler: listTransactionalEmails,
	});

	// POST /api/v1/transactional-emails - Create a transactional email
	http.route({
		path: '/api/v1/transactional-emails',
		method: 'POST',
		handler: createTransactionalEmail,
	});

	// GET /api/v1/transactional-emails/{slug} - One transactional email
	http.route({
		pathPrefix: '/api/v1/transactional-emails/',
		method: 'GET',
		handler: getTransactionalEmail,
	});

	// PUT /api/v1/transactional-emails/{slug} - Create or replace by slug
	http.route({
		pathPrefix: '/api/v1/transactional-emails/',
		method: 'PUT',
		handler: putTransactionalEmail,
	});

	// POST /api/v1/transactional-emails/{slug}/publish and /unpublish
	http.route({
		pathPrefix: '/api/v1/transactional-emails/',
		method: 'POST',
		handler: transitionTransactionalEmail,
	});

	// ============ SAVED BLOCK ENDPOINTS ============

	// GET /api/v1/saved-blocks - List saved blocks
	http.route({
		path: '/api/v1/saved-blocks',
		method: 'GET',
		handler: listSavedBlocks,
	});

	// POST /api/v1/saved-blocks - Create a saved block
	http.route({
		path: '/api/v1/saved-blocks',
		method: 'POST',
		handler: createSavedBlock,
	});

	// GET /api/v1/saved-blocks/{id} - One saved block
	http.route({
		pathPrefix: '/api/v1/saved-blocks/',
		method: 'GET',
		handler: getSavedBlock,
	});

	// PUT /api/v1/saved-blocks/{id} - Replace a saved block
	http.route({
		pathPrefix: '/api/v1/saved-blocks/',
		method: 'PUT',
		handler: updateSavedBlock,
	});

	// POST /api/v1/render - Render blocks without storing them
	http.route({
		path: '/api/v1/render',
		method: 'POST',
		handler: renderEmail,
	});

	// ============ STATUS API ENDPOINTS ============

	// GET /api/v1/status - Whether the instance can send, and why not
	http.route({
		path: '/api/v1/status',
		method: 'GET',
		handler: getStatus,
	});

	// ============ DOMAINS API ENDPOINTS ============

	// GET /api/v1/domains - Sending domains and the DNS records each needs
	http.route({
		path: '/api/v1/domains',
		method: 'GET',
		handler: listDomains,
	});

	// POST /api/v1/domains/{domain}/verify - Queue a fresh check of one domain
	http.route({
		pathPrefix: '/api/v1/domains/',
		method: 'POST',
		handler: verifyDomain,
	});

	// ============ LIMITS API ENDPOINTS ============

	// GET /api/v1/limits - The send limits of this key, and what is left
	http.route({
		path: '/api/v1/limits',
		method: 'GET',
		handler: getLimits,
	});

	// ============ TOPICS API ENDPOINTS ============

	// GET /api/v1/topics - List topics
	http.route({
		path: '/api/v1/topics',
		method: 'GET',
		handler: listTopics,
	});

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
