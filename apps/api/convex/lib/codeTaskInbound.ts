/**
 * Inbound feature-request → code work task, behind its trust gates.
 *
 * Lives apart from `codeWorkTasks.ts` (which keeps the `createFromInbound`
 * entry point) so the worker protocol there stays readable.
 */
import { normalizeEmail } from '@owlat/shared';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { openInboundMessageBody } from './messageBodyInbound';
import { isFeatureEnabled } from './featureFlags';
import { extractEmail } from './emailAddress';
import { checkCodeAgentSafety, isDmarcAligned } from './codeAgentGuard';
import { CODE_TASK_MAX_ATTEMPTS } from './codeTaskRetry';

/**
 * Is the inbound sender a trusted org member?
 *
 * A code-work task hands an attacker-controllable email body to an autonomous
 * coding agent, so ONLY mail from an org member (a real, provisioned account on
 * this single-org instance) may spawn one. Membership is resolved from
 * `userProfiles` — the org member table — matched on the normalized sender
 * address. The table is small (one org per deployment), so a bounded scan is
 * both cheap and casing-robust regardless of how BetterAuth stored the address.
 * Soft-deleted profiles are excluded.
 */
async function isTrustedInboundSender(ctx: MutationCtx, fromField: string): Promise<boolean> {
	const sender = extractEmail(fromField);
	if (!sender) return false;

	// Fast path: exact match on the by_email index (emails commonly stored
	// lowercased). Falls through to a bounded normalized scan otherwise.
	const exact = await ctx.db
		.query('userProfiles')
		.withIndex('by_email', (q) => q.eq('email', sender))
		.first();
	if (exact && !exact.deletedAt) return true;

	const profiles = await ctx.db.query('userProfiles').take(1000);
	return profiles.some((p) => !p.deletedAt && normalizeEmail(p.email) === sender);
}

/**
 * Create a code work task from an inbound feature-request message and return
 * its id, or null when a gate declines it.
 *
 * Called by the inbox processing lifecycle when a message is classified as a
 * feature request. Fails safe on several fronts before anything reaches the
 * coding agent:
 *   - the `inbox.codeTasks` feature flag must be on (off by default);
 *   - the message must carry a DMARC-aligned `pass` (computed by the MTA over
 *     the raw bytes at ingest). The allowlist below keys on the verbatim,
 *     forgeable "From" address; without this gate a spoofed member address would
 *     satisfy it. DMARC binds the From domain to an aligned SPF/DKIM pass, so it
 *     is the primary anti-spoofing control here, checked BEFORE the allowlist;
 *   - the sender must be a trusted org member — an untrusted sender's mail
 *     still processes as normal inbound, it simply does NOT spawn a code task
 *     (a stranger cannot direct the coding agent by emailing the inbox);
 *   - a code-agent-specific appropriateness check must pass — instructions
 *     smuggled to a CODE agent ("add a backdoor", "leak the env secrets",
 *     "force-push to main") are distinct from the email-assistant injection
 *     the upstream `security_scan` step guards, so they get their own gate.
 * We never create a second task for the same inbound message (idempotent on
 * `inboundMessageId`).
 */
export async function createCodeTaskFromInbound(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<Id<'codeWorkTasks'> | null> {
	// Feature gate — boolean check (internal mutation, no throwing).
	if (!(await isFeatureEnabled(ctx, 'inbox.codeTasks'))) {
		return null;
	}

	// Idempotency: never spawn a second task for the same inbound message.
	const existing = await ctx.db
		.query('codeWorkTasks')
		.withIndex('by_inbound', (q) => q.eq('inboundMessageId', inboundMessageId))
		.first();
	if (existing) {
		return existing._id;
	}

	const message = await ctx.db.get(inboundMessageId);
	if (!message) {
		return null;
	}

	// DMARC gate (PRIMARY anti-spoofing control): the allowlist below trusts
	// the verbatim "From" header, which any sender can forge. Require a
	// DMARC-aligned pass — the MTA computed it over the raw bytes at ingest —
	// so a forged member address cannot direct the coding agent. Fails CLOSED:
	// an absent/failed/non-pass verdict spawns no task (the mail still
	// processes as normal inbound). The content denylist stays as backstop.
	if (!isDmarcAligned(message)) {
		return null;
	}

	// Trust gate: only org members may spawn code-work tasks. Untrusted
	// senders are processed as normal inbound (already done upstream); they
	// just don't reach the coding agent.
	if (!(await isTrustedInboundSender(ctx, message.from))) {
		return null;
	}

	// Code-agent appropriateness check, distinct from the email-assistant
	// injection guard. A body held in storage is checked (and described below)
	// by its excerpt, because a mutation cannot read the blob.
	const { text, html, excerpt, isComplete } = await openInboundMessageBody(message, null);
	const safety = checkCodeAgentSafety({
		subject: message.subject ?? '',
		textBody: text ?? excerpt,
		htmlBody: html,
	});
	if (!safety.safe) {
		return null;
	}

	// Build the task description from the inbound subject + body.
	const subject = message.subject?.trim() || '(no subject)';
	const body = (text ?? excerpt ?? html ?? '').trim();
	const note = isComplete ? '' : '\n\n[Shortened: the full text is in the Team Inbox.]';
	const description = body ? `${subject}\n\n${body}${note}` : subject;

	const now = Date.now();
	return await ctx.db.insert('codeWorkTasks', {
		description,
		inboundMessageId: inboundMessageId,
		status: 'queued',
		attempts: 0,
		maxAttempts: CODE_TASK_MAX_ATTEMPTS,
		createdAt: now,
		updatedAt: now,
	});
}
