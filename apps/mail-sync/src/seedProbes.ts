/**
 * Deliverability seed-probe sweep — step 3 (classify) and the hygiene executor.
 *
 * Owlat drops a shadow copy of a send into each operator-owned SEED mailbox,
 * tagged with an opaque id in the `X-Owlat-Seed-Probe` header. This sweep walks
 * those mailboxes with the SHIPPED IMAP client, reports which FOLDER each probe
 * landed in (or that it could not be found at all — MISSING, the outcome no
 * other signal surfaces), and then performs the hygiene the backend planned:
 * mark the probe read, and occasionally click a link. A seed that never opens
 * anything trains the provider to distrust us.
 *
 * WHAT THE PROVIDER ACTUALLY SEES, plainly: the IMAP `\Seen` flag. That is the
 * hygiene signal — it is set on the provider's own store, so the provider is
 * the one observing it. The occasional CLICK is a server-side request from the
 * worker's IP, not from the mailbox's client, so no provider attributes it to
 * the seed; what it does buy is a real exercise of this deployment's own
 * tracking redirect for a message that really landed, end to end. Both are
 * worth doing; only one of them is engagement.
 *
 * Boundaries this module holds:
 *   - Mailbox CONTENTS never leave the worker. The only things reported back
 *     are a probe id and a folder NAME.
 *   - Credentials come from the shipped sealed-secret path and are never
 *     logged; every log line about a seed account goes through
 *     `toSeedAccountLogView`, which reduces it to an account id, a provider and
 *     a domain — never a full address, a password, or a subject.
 *   - Every dependency is injected, so the whole sweep — including hygiene —
 *     is testable with no network at all.
 *   - D2: zero seed mailboxes means zero work items and a no-op sweep. It
 *     never throws, never warns, and never blocks anything.
 */

import {
	toSeedAccountLogView,
	type SeedHygienePlan,
	type SeedPlacement,
	type SeedProbeWorkItem,
	type SeedProbeWorkPage,
} from '@owlat/shared/seedPlacement';
import { logger } from './logger.js';

// The wire contract with the Convex poller surface lives in @owlat/shared, so
// there is exactly one declaration of it across the two deployables.
export type { SeedHygienePlan, SeedPlacement, SeedProbeWorkItem, SeedProbeWorkPage };

export interface SeedProbeLocation {
	folderName: string;
	uid: number;
}

/**
 * One opened seed mailbox. Implemented over the shipped IMAP client in
 * production and by a fixture in tests — this module never speaks IMAP itself.
 */
export interface SeedMailboxSession {
	/**
	 * Locate a BATCH of probes by header value. One pass per folder, not one pass
	 * per probe: an absent key is MISSING. Batched because the per-probe shape
	 * costs O(probes x folders) mailbox SELECTs.
	 */
	findProbes(probeIds: readonly string[]): Promise<Map<string, SeedProbeLocation>>;
	markRead(location: SeedProbeLocation): Promise<void>;
	/** Link targets inside the probe. Used only to exercise ONE click. */
	linkTargets(location: SeedProbeLocation): Promise<string[]>;
	close(): Promise<void>;
}

export interface SeedProbeDeps {
	now(): number;
	/** Uniform [0,1) draw handed to the backend so the decision stays pure. */
	random(): number;
	/**
	 * One PAGE of work. `cursor` is carried between ticks so a multi-org
	 * deployment cannot starve the orgs that sort last behind a fixed top-N.
	 */
	listWork(now: number, cursor: string | null): Promise<SeedProbeWorkPage>;
	openMailbox(item: SeedProbeWorkItem): Promise<SeedMailboxSession | null>;
	recordClassification(input: {
		organizationId: string;
		probeId: string;
		folderName: string | null;
		now: number;
		clickRoll: number;
	}): Promise<{ recorded: boolean; placement?: SeedPlacement; hygiene?: SeedHygienePlan }>;
	/**
	 * Ask the backend to EMIT the rotation nudge. It re-checks due-ness against
	 * the stored timestamps and only records the reminder if it actually emitted
	 * one, so a sweep that produces no notification leaves the flag standing.
	 */
	emitRotationReminder(input: {
		organizationId: string;
		accountId: string;
		now: number;
	}): Promise<{ emitted: boolean }>;
	/** Perform the occasional click. Best-effort; a failure is never fatal. */
	click(url: string): Promise<void>;
}

export interface SeedProbeSweepResult {
	accounts: number;
	classified: number;
	missing: number;
	markedRead: number;
	clicked: number;
	rotationReminders: number;
	/** Accounts whose mailbox could not be opened — skipped, never classified. */
	unopened: number;
}

/** Path fragments that are never a CONTENT link, in the order they appear. */
const NON_CONTENT_LINK_FRAGMENTS = ['/unsub', '/unsubscribe', '/preferences', '/t/o/'];

/**
 * Pick the link the hygiene click should exercise.
 *
 * TWO filters, and both are load-bearing.
 *
 * CONTENT-SHAPED. "The occasional click" is supposed to look like a subscriber
 * reading the mail: the first href in a template is just as likely to be the
 * footer's one-click unsubscribe or the open pixel, and clicking those teaches
 * the provider the opposite of what we want (and, for the unsubscribe target,
 * exercises a mutation rather than a read).
 *
 * OURS. The candidates come out of a message sitting on a mail server we do
 * not run, so the target must be on one of the deployment's OWN origins, which
 * the backend supplies with the work item. A campaign's content links are
 * wrapped through the tracking domain, so the link we actually want already
 * qualifies; anything else is not a link we put there in a form we recognise.
 *
 * When nothing qualifies we click NOTHING — a skipped click is a missing data
 * point; a clicked unsubscribe, or a request to somewhere we were talked into,
 * is a wrong one.
 */
export function chooseHygieneClickTarget(
	targets: readonly string[],
	allowedHosts: readonly string[]
): string | undefined {
	if (allowedHosts.length === 0) return undefined;
	const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
	return targets.find((target) => {
		if (!/^https?:\/\//i.test(target)) return false;
		if (/\.(?:gif|png|jpe?g|webp)(?:\?|$)/i.test(target)) return false;
		const lowered = target.toLowerCase();
		if (NON_CONTENT_LINK_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return false;
		try {
			return allowed.has(new URL(target).host.toLowerCase());
		} catch {
			return false;
		}
	});
}

async function classifyOne(
	deps: SeedProbeDeps,
	item: SeedProbeWorkItem,
	session: SeedMailboxSession | null,
	probeId: string,
	location: SeedProbeLocation | null,
	result: SeedProbeSweepResult
): Promise<void> {
	const outcome = await deps.recordClassification({
		organizationId: item.organizationId,
		probeId,
		folderName: location ? location.folderName : null,
		now: deps.now(),
		clickRoll: deps.random(),
	});
	if (!outcome.recorded) return;
	result.classified += 1;
	if (outcome.placement === 'missing') result.missing += 1;
	if (!location || !session || !outcome.hygiene) return;

	if (outcome.hygiene.markRead) {
		await session.markRead(location);
		result.markedRead += 1;
	}
	if (outcome.hygiene.click) {
		const targets = await session.linkTargets(location);
		const target = chooseHygieneClickTarget(targets, item.clickHosts);
		if (target !== undefined) {
			await deps.click(target);
			result.clicked += 1;
		}
	}
}

/** What one sweep tick returns: its counters plus where to resume next tick. */
export interface SeedProbeSweepOutcome extends SeedProbeSweepResult {
	/** Feed back into the next tick. `null` restarts the sweep from the top. */
	cursor: string | null;
}

/**
 * Walk one PAGE of seed mailboxes with outstanding probes exactly once.
 *
 * A failure on one account is logged and skipped: a probe is a measurement,
 * never a reason to fail anything else the worker is doing.
 */
export async function runSeedProbeSweep(
	deps: SeedProbeDeps,
	cursor: string | null = null
): Promise<SeedProbeSweepOutcome> {
	const result: SeedProbeSweepResult = {
		accounts: 0,
		classified: 0,
		missing: 0,
		markedRead: 0,
		clicked: 0,
		rotationReminders: 0,
		unopened: 0,
	};
	const page = await deps.listWork(deps.now(), cursor);
	for (const item of page.items) {
		result.accounts += 1;
		let session: SeedMailboxSession | null = null;
		try {
			// Probes past the give-up horizon are reported MISSING without a walk.
			for (const probeId of item.expiredProbeIds) {
				await classifyOne(deps, item, null, probeId, null, result);
			}
			if (item.probeIds.length > 0) {
				session = await deps.openMailbox(item);
				if (session === null) {
					// THE MAILBOX WAS NEVER OPENED, so nothing was observed.
					//
					// `openMailbox` reports a failed connect/LIST by returning null
					// rather than throwing, and a probe we could not look for is not a
					// probe we failed to find. Classifying this batch would record
					// MISSING — gate 5's most alarming outcome, and a PERMANENT one
					// (classification is once-only) — for every outstanding probe on the
					// account, manufacturing a provider-wide `collapse_suspected` out of
					// an expired app password or an IMAP maintenance window. The probes
					// stay outstanding and are selected again next tick; only the
					// give-up horizon (`expiredProbeIds`) may ever produce MISSING.
					result.unopened += 1;
				} else {
					// ONE pass over the folders for the whole batch (see `findProbes`).
					const located = await session.findProbes(item.probeIds);
					for (const probeId of item.probeIds) {
						await classifyOne(deps, item, session, probeId, located.get(probeId) ?? null, result);
					}
				}
			}
			if (item.rotationReminderDue) {
				// The backend decides whether a reminder is really due and EMITS the
				// operator-visible artifact before recording that it did; the sweep
				// only offers it the chance. A tick that emits nothing leaves the flag
				// standing for the next one.
				const { emitted } = await deps.emitRotationReminder({
					organizationId: item.organizationId,
					accountId: item.accountId,
					now: deps.now(),
				});
				if (emitted) result.rotationReminders += 1;
			}
		} catch (err) {
			// Never log the address, the credentials, or anything from the mailbox.
			// `toSeedAccountLogView` is the one shape a seed account may be logged
			// in — it reduces the address to its domain — so the redaction rule is
			// enforced by a function instead of by remembering it at each call site.
			logger.warn({ err, ...toSeedAccountLogView(item) }, 'seed probe sweep failed for account');
		} finally {
			if (session) await session.close().catch(() => undefined);
		}
	}
	return { ...result, cursor: page.cursor };
}
