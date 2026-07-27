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

import { logger } from './logger.js';

/** Where the backend says a probe ended up. Mirrors `SEED_PLACEMENTS`. */
export type SeedPlacement = 'inbox' | 'category' | 'spam' | 'deleted' | 'missing';

export interface SeedProbeWorkItem {
	organizationId: string;
	accountId: string;
	address: string;
	provider: string;
	probeIds: string[];
	expiredProbeIds: string[];
	rotationReminderDue: boolean;
}

/** What the backend decided should happen to a probe after classification. */
export interface SeedHygienePlan {
	markRead: boolean;
	click: boolean;
}

export interface SeedProbeLocation {
	folderName: string;
	uid: number;
}

/**
 * One opened seed mailbox. Implemented over the shipped IMAP client in
 * production and by a fixture in tests — this module never speaks IMAP itself.
 */
export interface SeedMailboxSession {
	/** Locate a probe by its header value across every folder. `null` ⇒ MISSING. */
	findProbe(probeId: string): Promise<SeedProbeLocation | null>;
	markRead(location: SeedProbeLocation): Promise<void>;
	/** Link targets inside the probe. Used only to exercise ONE click. */
	linkTargets(location: SeedProbeLocation): Promise<string[]>;
	close(): Promise<void>;
}

export interface SeedProbeDeps {
	now(): number;
	/** Uniform [0,1) draw handed to the backend so the decision stays pure. */
	random(): number;
	listWork(now: number): Promise<SeedProbeWorkItem[]>;
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

async function classifyOne(
	deps: SeedProbeDeps,
	item: SeedProbeWorkItem,
	session: SeedMailboxSession | null,
	probeId: string,
	result: SeedProbeSweepResult
): Promise<void> {
	const location = session ? await session.findProbe(probeId) : null;
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
		const target = targets[0];
		if (target !== undefined) {
			await deps.click(target);
			result.clicked += 1;
		}
	}
}

/**
 * Walk every seed mailbox with outstanding probes exactly once.
 *
 * A failure on one account is logged and skipped: a probe is a measurement,
 * never a reason to fail anything else the worker is doing.
 */
export async function runSeedProbeSweep(deps: SeedProbeDeps): Promise<SeedProbeSweepResult> {
	const result: SeedProbeSweepResult = {
		accounts: 0,
		classified: 0,
		missing: 0,
		markedRead: 0,
		clicked: 0,
		rotationReminders: 0,
	};
	const work = await deps.listWork(deps.now());
	for (const item of work) {
		result.accounts += 1;
		let session: SeedMailboxSession | null = null;
		try {
			// Probes past the give-up horizon are reported MISSING without a walk.
			for (const probeId of item.expiredProbeIds) {
				await classifyOne(deps, item, null, probeId, result);
			}
			if (item.probeIds.length > 0) {
				session = await deps.openMailbox(item);
				for (const probeId of item.probeIds) {
					await classifyOne(deps, item, session, probeId, result);
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
	return result;
}
