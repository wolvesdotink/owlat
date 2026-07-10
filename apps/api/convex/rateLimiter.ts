import { RateLimiter, SECOND, MINUTE } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';

/**
 * Persistent rate limiter using Convex database storage
 * This properly persists rate limit state across function invocations
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
	// API rate limit: 10 requests per second per API key
	// Using token bucket to allow some burst capacity
	apiRequest: {
		kind: 'token bucket',
		rate: 10,
		period: SECOND,
		capacity: 15, // Allow burst up to 15 requests
	},

	// Form submissions: strict spam prevention (5 per minute per IP)
	formSubmission: {
		kind: 'fixed window',
		rate: 5,
		period: MINUTE,
	},

	// Email tracking: high volume legitimate traffic (100 per minute per IP, burst to 150)
	emailTracking: {
		kind: 'token bucket',
		rate: 100,
		period: MINUTE,
		capacity: 150,
	},

	// Subscription management: unsubscribe, preferences (30 per minute per IP)
	subscriptionManagement: {
		kind: 'fixed window',
		rate: 30,
		period: MINUTE,
	},

	// DOI confirmations: one-time actions (20 per minute per IP)
	doiConfirmation: {
		kind: 'fixed window',
		rate: 20,
		period: MINUTE,
	},

	// Webhook ingestion: provider bursts expected (50 per second per IP, burst to 100)
	webhookIngestion: {
		kind: 'token bucket',
		rate: 50,
		period: SECOND,
		capacity: 100,
	},

	// Test/preview email sends: a preview action emits real mail from the
	// verified sending domain, so cap it per user (refill 10/min, burst 20) so
	// the 5-recipient-per-call limit can't be looped into a reputation-burning
	// volume.
	testEmailSend: {
		kind: 'token bucket',
		rate: 10,
		period: MINUTE,
		capacity: 20,
	},

	// Inbound AI-agent pipeline starts. Each run spends multiple LLM calls
	// (guard + classify + capable-tier draft + extract), and inbound email
	// volume is attacker-controlled, so cap how many pipeline runs an individual
	// sender — and the whole instance — can trigger per window. Over the cap,
	// the message is still stored; only the expensive AI processing is skipped.
	agentPipelinePerSender: {
		kind: 'token bucket',
		rate: 10,
		period: MINUTE,
		capacity: 20,
	},
	agentPipelineGlobal: {
		kind: 'token bucket',
		rate: 60,
		period: MINUTE,
		capacity: 120,
	},

	// User-triggered Postbox AI (thread summarize / suggested replies). Each
	// click spends a capable-tier LLM call, so cap per-user to stop a tight loop
	// from draining the LLM budget while leaving normal interactive use roomy.
	postboxAiPerUser: {
		kind: 'token bucket',
		rate: 20,
		period: MINUTE,
		capacity: 30,
	},

	// User-triggered AI assistant / @assistant-in-chat turns. Each turn spends a
	// capable-tier streaming LLM call plus tool round-trips, so cap per-user to
	// stop a tight send loop from draining the LLM budget while leaving normal
	// interactive use roomy.
	assistantChatPerUser: {
		kind: 'token bucket',
		rate: 20,
		period: MINUTE,
		capacity: 30,
	},

	// Admin "Test connection" probes on the AI-providers settings page. Each hit
	// decrypts the stored key and (for local providers) makes an outbound
	// reachability request, so cap per-user to stop a tight loop from turning the
	// button into an SSRF/credential-probe amplifier.
	aiProviderConfigTest: {
		kind: 'token bucket',
		rate: 10,
		period: MINUTE,
		capacity: 15,
	},
});
