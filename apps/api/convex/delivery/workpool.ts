import { Workpool } from '@convex-dev/workpool';
import { components } from '../_generated/api';

/**
 * Email Workpool Configuration
 *
 * Two separate pools for rate limiting email sends:
 * - transactionalEmailPool: Higher priority, 30/sec for time-sensitive transactional emails
 * - campaignEmailPool: Lower priority, 20/sec for bulk marketing campaigns
 *
 * Combined ~50/sec stays under Resend's 100/sec limit with safety margin.
 * This ensures transactional emails won't be blocked behind campaign queues.
 *
 * Retry authority: the **Send dispatch (helper)** (`lib/sendProviders/dispatch.ts`,
 * per ADR-0020) owns the send-side retry loop — it calls each provider's
 * single-attempt `sendEmail` up to `1 + retryDelays.length` times, classifying
 * errors via the module's `categorizeError`. The workpool MUST NOT layer its own
 * retry on top: a workpool retry re-runs the WHOLE worker action, multiplying the
 * dispatch helper's attempts (3×3 ≈ 9-12 provider POSTs for one send) and — worse
 * — re-POSTing AFTER a provider already accepted the message when a client-side
 * timeout is (correctly) categorized as a retryable SERVER_ERROR, causing
 * duplicate deliveries. `maxAttempts: 1` = exactly one worker run, no workpool
 * retry (the component retries only while `attempts < maxAttempts`), so the
 * dispatch helper is the SOLE retry authority. Worker actions are not idempotent
 * across full re-runs, so per `@convex-dev/workpool` guidance they must not be
 * auto-retried at the pool level.
 */

/**
 * Single source of truth for the email-pool retry behavior. Both pools share it
 * so prod and the tests that assert it (`__tests__/inboundMutations.integration.test.ts`)
 * cannot drift. `maxAttempts: 1` is total attempts including the first — i.e. no
 * pool-level retry.
 */
export const EMAIL_WORKPOOL_RETRY_BEHAVIOR = {
	maxAttempts: 1,
	initialBackoffMs: 1000,
	base: 2,
} as const;

// Transactional emails - higher priority, higher parallelism
export const transactionalEmailPool = new Workpool(components.transactionalEmailPool, {
	maxParallelism: 30, // 30/sec for time-sensitive transactional emails
	retryActionsByDefault: true,
	defaultRetryBehavior: EMAIL_WORKPOOL_RETRY_BEHAVIOR,
});

// Campaign emails - lower priority, bulk sending
export const campaignEmailPool = new Workpool(components.campaignEmailPool, {
	maxParallelism: 20, // 20/sec for bulk marketing (lower priority)
	retryActionsByDefault: true,
	defaultRetryBehavior: EMAIL_WORKPOOL_RETRY_BEHAVIOR,
});
