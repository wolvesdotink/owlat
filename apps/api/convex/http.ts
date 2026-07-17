import { httpRouter } from 'convex/server';
import { authComponent, createAuth } from './auth/auth';
import { trackOpen, trackClick } from './delivery/trackingHttp';
import { handleCors, healthCheck } from './auth/apiAuth';
import { seedAdmin } from './seedAdmin';
import { seedDemoHttp } from './seedDemo';
import { resetHttp } from './devShortcuts/reset';
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
import { handleOneClickUnsubscribe, verifyUnsubscribeToken } from './delivery/unsubscribeHttp';
import { verifyPreferenceToken, updatePreferences } from './delivery/preferencesHttp';
import { submitForm, handleFormCors } from './forms/apiHttp';
import { handleResendWebhook } from './resendWebhook';
import { handleMtaWebhook } from './mtaWebhook';
import { handleSesWebhook } from './sesWebhook';
import { handleMailWebhook } from './mail/webhook';
import { serveSealedBlob } from './mail/sealedBlobHttp';
import { handleVerifyCredential } from './mail/authHttp';
import { handleTlsReportWebhook } from './domains/tlsReportsHttp';
import { handleSmsWebhook, handleWhatsAppWebhook, handleGenericWebhook } from './webhooks/channels';
import { handleGithubWebhook } from './webhooks/githubHttp';
import { handleSlackApprovalCallback } from './slack/approvalsHttp';
import { verifyContactDoiToken, confirmContactDoi } from './topics/doiHttp';
import { getCampaignArchive } from './campaigns/archiveHttp';
import { getShareLink } from './shareLinkHttp';

const http = httpRouter();

// Email tracking routes
// Open tracking pixel: GET /t/o/{emailSendId}
http.route({
	pathPrefix: '/t/o/',
	method: 'GET',
	handler: trackOpen,
});

// Click tracking redirect: GET /t/c/{emailSendId}/{encodedUrl}
http.route({
	pathPrefix: '/t/c/',
	method: 'GET',
	handler: trackClick,
});

// ============ UNSUBSCRIBE ROUTES ============

// One-click unsubscribe (RFC 8058): POST /unsub/{token}
http.route({
	pathPrefix: '/unsub/',
	method: 'POST',
	handler: handleOneClickUnsubscribe,
});

// Verify unsubscribe token: GET /unsub/verify/{token}
http.route({
	pathPrefix: '/unsub/verify/',
	method: 'GET',
	handler: verifyUnsubscribeToken,
});

// CORS preflight for verify endpoint
http.route({
	pathPrefix: '/unsub/verify/',
	method: 'OPTIONS',
	handler: verifyUnsubscribeToken,
});

// ============ PREFERENCE CENTER ROUTES ============

// Verify preference token: GET /prefs/verify/{token}
http.route({
	pathPrefix: '/prefs/verify/',
	method: 'GET',
	handler: verifyPreferenceToken,
});

// CORS preflight for preference verify endpoint
http.route({
	pathPrefix: '/prefs/verify/',
	method: 'OPTIONS',
	handler: verifyPreferenceToken,
});

// Update preferences: POST /prefs/update/{token}
http.route({
	pathPrefix: '/prefs/update/',
	method: 'POST',
	handler: updatePreferences,
});

// CORS preflight for preference update endpoint
http.route({
	pathPrefix: '/prefs/update/',
	method: 'OPTIONS',
	handler: updatePreferences,
});

// ============ PUBLIC API v1 ROUTES ============

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

// ============ FORM SUBMISSION ENDPOINTS ============

// CORS preflight for form submission
http.route({
	pathPrefix: '/forms/',
	method: 'OPTIONS',
	handler: handleFormCors,
});

// POST /forms/{formId} - Submit a form (public endpoint)
http.route({
	pathPrefix: '/forms/',
	method: 'POST',
	handler: submitForm,
});

// ============ EMAIL PROVIDER WEBHOOK ENDPOINTS ============

// POST /webhooks/resend - Handle Resend webhook events (bounce, complaint)
http.route({
	path: '/webhooks/resend',
	method: 'POST',
	handler: handleResendWebhook,
});

// POST /webhooks/mta - Handle custom MTA webhook events (bounce, complaint, IP events)
http.route({
	path: '/webhooks/mta',
	method: 'POST',
	handler: handleMtaWebhook,
});

// POST /webhooks/ses - Handle AWS SES feedback via SNS (bounce, complaint, delivery)
http.route({
	path: '/webhooks/ses',
	method: 'POST',
	handler: handleSesWebhook,
});

// POST /webhooks/mta-mailbox - Personal-mail (Postbox) inbound delivery from MTA
http.route({
	path: '/webhooks/mta-mailbox',
	method: 'POST',
	handler: handleMailWebhook,
});

// POST /webhooks/mta-verify-credential - app-password verification for MTA SMTP submission
http.route({
	path: '/webhooks/mta-verify-credential',
	method: 'POST',
	handler: handleVerifyCredential,
});

// POST /webhooks/mta-tls-report - inbound TLS-RPT (RFC 8460) aggregate reports
// forwarded from the MTA's system inbound route for the `_smtp._tls` rua address
http.route({
	path: '/webhooks/mta-tls-report',
	method: 'POST',
	handler: handleTlsReportWebhook,
});

// POST /webhooks/slack/approvals - Slack approvals reference app (Tier-2, PP-26)
// interaction callback. v0-signature + replay-window verified; records one
// deduplicated approve/reject vote against a held autonomous send. Never sends.
http.route({
	path: '/webhooks/slack/approvals',
	method: 'POST',
	handler: handleSlackApprovalCallback,
});

// GET /sealed-blob - decrypt-serving proxy for sealed storage blobs (Sealed
// Mail E8b). Reads a sealed blob named by a capability token, unseals it, and
// streams the plaintext bytes to the web reader / IMAP bridge / outbound MTA.
http.route({
	path: '/sealed-blob',
	method: 'GET',
	handler: serveSealedBlob,
});

// ============ CHANNEL WEBHOOK ENDPOINTS ============

// POST /webhooks/sms - Twilio SMS inbound
http.route({
	path: '/webhooks/sms',
	method: 'POST',
	handler: handleSmsWebhook,
});

// POST /webhooks/whatsapp - Meta WhatsApp inbound
http.route({
	path: '/webhooks/whatsapp',
	method: 'POST',
	handler: handleWhatsAppWebhook,
});

// GET /webhooks/whatsapp - Meta webhook verification challenge
http.route({
	path: '/webhooks/whatsapp',
	method: 'GET',
	handler: handleWhatsAppWebhook,
});

// POST /webhooks/channel - Generic webhook inbound
http.route({
	path: '/webhooks/channel',
	method: 'POST',
	handler: handleGenericWebhook,
});

// POST /webhooks/github - GitHub PR merge events → mark code-work tasks merged
http.route({
	path: '/webhooks/github',
	method: 'POST',
	handler: handleGithubWebhook,
});

// ============ DOI CONFIRMATION ROUTES ============

// GET /confirm/doi/verify - Verify contact DOI token (get info before confirming)
http.route({
	path: '/confirm/doi/verify',
	method: 'GET',
	handler: verifyContactDoiToken,
});

// CORS preflight for verify endpoint
http.route({
	path: '/confirm/doi/verify',
	method: 'OPTIONS',
	handler: verifyContactDoiToken,
});

// POST /confirm/doi - Confirm contact DOI via token
http.route({
	path: '/confirm/doi',
	method: 'POST',
	handler: confirmContactDoi,
});

// CORS preflight for confirm endpoint
http.route({
	path: '/confirm/doi',
	method: 'OPTIONS',
	handler: confirmContactDoi,
});

// ============ CAMPAIGN ARCHIVE ROUTES ============

// GET /archive/{token} - Public campaign archive
http.route({
	pathPrefix: '/archive/',
	method: 'GET',
	handler: getCampaignArchive,
});

// CORS preflight for archive endpoint
http.route({
	pathPrefix: '/archive/',
	method: 'OPTIONS',
	handler: getCampaignArchive,
});

// ============ SHARE LINK ROUTES ============

// GET /share/{token} - Public share link preview
http.route({
	pathPrefix: '/share/',
	method: 'GET',
	handler: getShareLink,
});

// CORS preflight for share link endpoint
http.route({
	pathPrefix: '/share/',
	method: 'OPTIONS',
	handler: getShareLink,
});

// ============ ADMIN SEED ENDPOINT ============

// POST /seed/admin - Seed the first admin user (one-shot, protected by instance secret)
http.route({
	path: '/seed/admin',
	method: 'POST',
	handler: seedAdmin,
});

// POST /seed/demo - Seed realistic demo content (dev/selfhost only, idempotent)
http.route({
	path: '/seed/demo',
	method: 'POST',
	handler: seedDemoHttp,
});

// POST /dev/reset - Wipe instance back to blank slate (dev/selfhost only)
http.route({
	path: '/dev/reset',
	method: 'POST',
	handler: resetHttp,
});

// ============ THIRD-PARTY ROUTE REGISTRATIONS ============
// IMPORTANT: Register third-party routes (BetterAuth) AFTER all custom
// http.route() calls. Their registerRoutes() implementations interfere with
// subsequent route registrations in the Convex HTTP router.

// Register BetterAuth routes with the HTTP router
// This handles all /api/auth/* endpoints
// Cast required: BetterAuth component bundles its own copy of Convex types
// which are structurally identical but nominally different (bun duplicate resolution)
// cors is required for the desktop app: the browser web client proxies auth
// same-origin through the Nuxt server, but the desktop webview calls this
// router cross-origin (auth-client.ts desktop branch, crossDomain plugin with
// a Better-Auth-Cookie header → CORS preflight). Without it registerRoutes
// only adds GET/POST routes, so every OPTIONS preflight 404s and desktop
// sign-in cannot reach /api/auth/* at all. `cors: true` allowlists the
// resolved trustedOrigins (SITE_URL, tauri://localhost, …) and the
// Better-Auth-Cookie / Set-Better-Auth-Cookie header pair.
authComponent.registerRoutes(
	http,
	createAuth as Parameters<typeof authComponent.registerRoutes>[1],
	{
		cors: true,
	}
);

export default http;
