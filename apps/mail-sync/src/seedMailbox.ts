/**
 * IMAP adapter for the seed-probe sweep.
 *
 * The only place this feature speaks IMAP. It uses the SAME `imapflow` client
 * and the SAME sealed-credential path as the inbound sync — there is no second
 * IMAP implementation and no second credential model.
 *
 * It reads exactly two things out of a seed mailbox: whether a probe is present
 * in a folder, and (only when the backend asked for a click) the link targets
 * inside that one probe. Nothing else — no subject, no body, no sender — is
 * ever returned to the caller, and nothing is logged.
 */

import { ImapFlow } from 'imapflow';
import { parseBody } from '@owlat/mail-message';
// The header is the feature's ONLY join key between the send and the IMAP
// observation, so both ends read the same constant rather than two copies
// behind a "must match" comment.
import { SEED_PROBE_HEADER } from '@owlat/shared/seedPlacement';
import type { SeedMailboxSession, SeedProbeLocation } from './seedProbes.js';
import type { WorkerCredentials } from './convex.js';

/** Folders never worth walking: our own copies, not the provider's verdict. */
const SKIPPED_FOLDER_FLAGS = new Set(['\\Sent', '\\Drafts', '\\All']);

/** Extract `href` targets from an already-DECODED HTML body. */
export function extractLinkTargets(html: string): string[] {
	const targets: string[] = [];
	const pattern = /href\s*=\s*"(https?:\/\/[^"]+)"/gi;
	let match = pattern.exec(html);
	while (match !== null) {
		const href = match[1];
		if (href !== undefined) targets.push(href);
		match = pattern.exec(html);
	}
	return targets;
}

/**
 * Link targets inside a RAW RFC 822 probe.
 *
 * The raw source CANNOT be scanned for hrefs directly. Campaign HTML with
 * wrapped tracking links is emitted quoted-printable
 * (`@owlat/mail-message` → `compose/encoding.ts`), which breaks every long URL
 * across `=\r\n` soft line breaks; the corrupted fragment still looks like a
 * URL to `chooseHygieneClickTarget`, so the click is fired at an address that
 * does not exist and the failure is swallowed — the hygiene click silently
 * never happens in production. Transfer-decoding the MIME tree first is what
 * makes the click real.
 */
export function extractProbeLinkTargets(rawSource: string): string[] {
	const body = parseBody(rawSource);
	if (body.html === false) return [];
	return extractLinkTargets(body.html);
}

class ImapSeedMailboxSession implements SeedMailboxSession {
	constructor(
		private readonly client: ImapFlow,
		private readonly folders: string[]
	) {}

	/**
	 * One pass per FOLDER, searching for every outstanding probe id at once.
	 *
	 * The obvious loop — for each probe, walk every folder — costs
	 * O(probes x folders) SELECTs, which against a Gmail label set and a full
	 * page of probes is hundreds of mailbox SELECTs per sweep. Inverted, a sweep
	 * costs O(folders) SELECTs: each folder is locked once and answers for the
	 * whole batch, and folders stop being opened at all once every probe is
	 * located.
	 */
	async findProbes(probeIds: readonly string[]): Promise<Map<string, SeedProbeLocation>> {
		const found = new Map<string, SeedProbeLocation>();
		for (const folderName of this.folders) {
			const outstanding = probeIds.filter((id) => !found.has(id));
			if (outstanding.length === 0) break;
			const lock = await this.client.getMailboxLock(folderName);
			try {
				for (const probeId of outstanding) {
					const uids = await this.client.search(
						{ header: { [SEED_PROBE_HEADER]: probeId } },
						{ uid: true }
					);
					const uid = Array.isArray(uids) ? uids[uids.length - 1] : undefined;
					if (typeof uid === 'number') found.set(probeId, { folderName, uid });
				}
			} catch {
				// A folder we cannot open is not evidence of anything; keep walking.
			} finally {
				lock.release();
			}
		}
		return found;
	}

	async markRead(location: SeedProbeLocation): Promise<void> {
		const lock = await this.client.getMailboxLock(location.folderName);
		try {
			await this.client.messageFlagsAdd(String(location.uid), ['\\Seen'], { uid: true });
		} finally {
			lock.release();
		}
	}

	async linkTargets(location: SeedProbeLocation): Promise<string[]> {
		const lock = await this.client.getMailboxLock(location.folderName);
		try {
			const message = await this.client.fetchOne(
				String(location.uid),
				{ source: true },
				{
					uid: true,
				}
			);
			const source = message === false ? undefined : message.source;
			if (!source) return [];
			return extractProbeLinkTargets(source.toString('utf8'));
		} finally {
			lock.release();
		}
	}

	async close(): Promise<void> {
		await this.client.logout();
	}
}

/**
 * Connect to one seed mailbox and enumerate the folders worth walking.
 *
 * Returns `null` rather than throwing when the mailbox cannot be opened: a
 * seed whose password expired must degrade the measurement, never the worker.
 */
export async function openSeedMailbox(
	credentials: WorkerCredentials
): Promise<SeedMailboxSession | null> {
	const client = new ImapFlow({
		host: credentials.imapHost,
		port: credentials.imapPort,
		secure: credentials.isImapSecure,
		auth: { user: credentials.imapUsername, pass: credentials.imapPassword },
		logger: false,
	});
	try {
		await client.connect();
		const list = await client.list();
		const folders = list
			.filter((box) => !box.flags.has('\\Noselect'))
			.filter((box) => ![...box.flags].some((flag) => SKIPPED_FOLDER_FLAGS.has(flag)))
			.map((box) => box.path);
		return new ImapSeedMailboxSession(client, folders);
	} catch {
		await client.logout().catch(() => undefined);
		return null;
	}
}
