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
 * Boundaries this module holds:
 *   - Mailbox CONTENTS never leave the worker. The only things reported back
 *     are a probe id and a folder NAME.
 *   - Credentials come from the shipped sealed-secret path and are never
 *     logged; log lines carry an account id and a provider, never an address,
 *     a password, or a subject.
 *   - Every dependency is injected, so the whole sweep — including hygiene —
 *     is testable with no network at all.
 *   - D2: zero seed mailboxes means zero work items and a no-op sweep. It
 *     never throws, never warns, and never blocks anything.
 */

import type {
	SeedHygienePlan,
	SeedPlacement,
	SeedProbeWorkItem,
	SeedProbeWorkPage,
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
	markRotationReminded(input: {
		organizationId: string;
		accountId: string;
		now: number;
	}): Promise<void>;
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
}

/** Path fragments that are never a CONTENT link, in the order they appear. */
const NON_CONTENT_LINK_FRAGMENTS = ['/unsub', '/unsubscribe', '/preferences', '/t/o/'];

/**
 * Pick the link the hygiene click should exercise.
 *
 * "The occasional click" is supposed to look like a subscriber reading the
 * mail, so it must be a CONTENT link: the first href in a template is just as
 * likely to be the footer's one-click unsubscribe or the open pixel, and
 * clicking those teaches the provider the opposite of what we want (and, for
 * the unsubscribe target, exercises a mutation rather than a read). When
 * nothing content-shaped is left we click NOTHING — a skipped click is a
 * missing data point; a clicked unsubscribe is a wrong one.
 */
export function chooseHygieneClickTarget(targets: readonly string[]): string | undefined {
	return targets.find((target) => {
		if (!/^https?:\/\//i.test(target)) return false;
		if (/\.(?:gif|png|jpe?g|webp)(?:\?|$)/i.test(target)) return false;
		const lowered = target.toLowerCase();
		return !NON_CONTENT_LINK_FRAGMENTS.some((fragment) => lowered.includes(fragment));
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
		const target = chooseHygieneClickTarget(targets);
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
				// ONE pass over the folders for the whole batch (see `findProbes`).
				const located: Map<string, SeedProbeLocation> = session
					? await session.findProbes(item.probeIds)
					: new Map();
				for (const probeId of item.probeIds) {
					await classifyOne(deps, item, session, probeId, located.get(probeId) ?? null, result);
				}
			}
			if (item.rotationReminderDue) {
				await deps.markRotationReminded({
					organizationId: item.organizationId,
					accountId: item.accountId,
					now: deps.now(),
				});
				result.rotationReminders += 1;
			}
		} catch (err) {
			// Never log the address, the credentials, or anything from the mailbox.
			logger.warn(
				{ err, accountId: item.accountId, provider: item.provider },
				'seed probe sweep failed for account'
			);
		} finally {
			if (session) await session.close().catch(() => undefined);
		}
	}
	return { ...result, cursor: page.cursor };
}
