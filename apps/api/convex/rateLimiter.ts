import { RateLimiter, SECOND, MINUTE, HOUR } from '@convex-dev/rate-limiter';
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

	// Failed API-key authentications, keyed per client IP. A wrong or unknown key
	// never reaches the per-key `apiRequest` bucket (there is no key to key it
	// on), so without a coarse per-IP failure throttle an attacker can probe key
	// hashes against the store unbounded. Only FAILURES consume a token, so a
	// legitimate client presenting a valid key is never affected. Generous enough
	// that an occasional typo'd key never trips it.
	apiKeyAuthFailure: {
		kind: 'token bucket',
		rate: 20,
		period: MINUTE,
		capacity: 40,
	},

	// Form submissions: strict spam prevention (5 per minute per IP)
	formSubmission: {
		kind: 'fixed window',
		rate: 5,
		period: MINUTE,
	},

	// Admin seed endpoint (`POST /seed/admin`). A one-shot bootstrap that hashes
	// nothing and touches the auth store; cap per IP so a spoofable-header-less
	// caller can't hammer it. Strict, since a healthy deployment calls it once.
	adminSeed: {
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

	// Inbound ATTACHMENT ingestion into the semantic file library. Units are
	// FILES, not messages: the per-message 10-part cap bounds one message, not a
	// sender sending a hundred of them at a route any sender can reach.
	//
	// The cost is not one model call. Per captured attachment it is one
	// summarize completion (semanticFileProcessing.ts) plus one embedding, and
	// when the extracted text is real rather than a `[Word document: …]`
	// placeholder, one further extract completion plus ONE EMBEDDING PER
	// EXTRACTED KNOWLEDGE ENTRY — a fan-out with no cap of its own
	// (knowledge/extraction.ts).
	//
	// Tripping either bucket skips indexing only: the message, its metadata and
	// the sealed raw `.eml` are all still stored, and the attachment stays
	// downloadable. The global bucket is charged as well as the per-sender one
	// because a spoofed From: mints a fresh per-sender bucket for free.
	attachmentIngestPerSender: {
		kind: 'token bucket',
		rate: 20,
		period: HOUR,
		capacity: 40,
	},
	attachmentIngestGlobal: {
		kind: 'token bucket',
		rate: 200,
		period: HOUR,
		capacity: 400,
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

	// User-triggered batch translation (`translate.translateBatch`). Each call
	// spends a fast-tier LLM call over a batch of items, so cap per-user to stop a
	// tight loop from draining the LLM budget while leaving normal editor use
	// roomy.
	translateBatchPerUser: {
		kind: 'token bucket',
		rate: 20,
		period: MINUTE,
		capacity: 30,
	},

	// User-triggered cross-source Quick Query (`quickQuery.ask`). Each ask spends
	// an embedding call plus a capable-tier synthesis call, so cap per-user to
	// stop a tight loop from draining the LLM budget while leaving normal
	// interactive use roomy.
	quickQueryPerUser: {
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

	// Admin "Load available models" fetches on the AI-providers settings page.
	// Each hit decrypts the stored key (hosted) and makes an outbound `/models`
	// request, so cap per-user like the Test-connection probe above to stop a
	// tight loop from turning the button into a credential-probe amplifier.
	aiProviderConfigListModels: {
		kind: 'token bucket',
		rate: 10,
		period: MINUTE,
		capacity: 15,
	},

	// Decision-plane calls (the typed-decision provider). Instance-global, not
	// per-sender: the plane is one upstream account with one shared quota, and a
	// decision is spent on inbound mail (attacker-controlled volume) as well as
	// on user-triggered surfaces. Sized off agentPipelineGlobal's 60 runs/min —
	// a migrated pipeline run spends about two decision calls, so twice that,
	// with room for the interactive callers on top. Over the cap the call is
	// refused outright rather than queued: a decision that arrives a minute late
	// is worth nothing to the step waiting on it.
	decisionPlaneGlobal: {
		kind: 'token bucket',
		rate: 120,
		period: MINUTE,
		capacity: 240,
	},

	// The decision plane's FAILURE budget — the circuit breaker in
	// decision/breaker.ts, not a limit anyone calls directly. Each failure on
	// the decision plane charges one token; while the budget is gone the breaker
	// reads `open` and the fallback hop onto the language model is refused. That
	// hop costs 24 to 50 times a decision call, so the sustained rate here IS
	// the cap on how much an upstream outage can cost us: 2 hops a minute, after
	// an initial burst of 20 while a real incident is still being recognized.
	// The refill doubles as the recovery curve — see decision/breaker.ts.
	decisionPlaneFailure: {
		kind: 'token bucket',
		rate: 2,
		period: MINUTE,
		capacity: 20,
	},

	// Direct-to-storage upload URL minting (media library, chat attachments).
	// The minted blob is inert until a gated mutation references it, but an
	// unbounded mint loop still fills `_storage` with orphaned bytes the
	// instance pays for. Cap per-user; roomy enough that interactive multi-file
	// uploads never hit it.
	storageUpload: {
		kind: 'token bucket',
		rate: 20,
		period: MINUTE,
		capacity: 40,
	},
});
