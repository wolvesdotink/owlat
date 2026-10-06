/**
 * The device mirror's offer scan (plan idea 7): which stored copies a composer
 * may offer back, and the cleanup a scan is allowed to do on the way.
 *
 * Copies of this composer's own session and of sessions still alive in another
 * tab are skipped. Expired copies go (retention); copies equal to the row go
 * (already saved, G1a), each through a conditional delete that re-checks the
 * scan is still current and, for equality, the row as it is at that moment.
 * Copies equal to what is on screen are skipped but kept (the compose page
 * merged them back; they go once the row holds them). Legacy (v1) entries
 * under the draft id, `new` or `new-reply:<id>` are offered with no base, so
 * Restore asks first. Split out of `usePostboxComposeMirror` for the file-size
 * ratchet; the publish guard stays there.
 */

import {
	copyMatches,
	isBlankMirrorFields,
	isMirrorCopyExpired,
	mirrorFieldsEqual,
	mirrorFieldsOfLegacy,
	type MirrorFieldName,
	type MirrorFields,
} from './postboxDraftMirror';
import type {
	LegacyMirrorRecord,
	MirrorCopyRecord,
	PostboxDraftMirrorStore,
} from './postboxDraftMirrorStore';

/** The offer the restore bar shows. */
export interface MirrorOffer {
	/** Where it is stored (another session's key, or a legacy key). */
	source: { kind: 'v2'; record: MirrorCopyRecord } | { kind: 'legacy'; record: LegacyMirrorRecord };
	fields: MirrorFields;
	base: MirrorFields | null;
	/** Only these fields are restored (a partial copy); absent means all. */
	present?: MirrorFieldName[];
	/** Client clock, for "from 14:32". */
	savedAt: number;
	/** Other copies holding the same text: resolving the offer resolves them too. */
	twins?: MirrorCopyRecord[];
}

export interface MirrorScan {
	ns: string;
	sessionId: string;
	/** The draft being composed; null for a composition without a row yet. */
	draftId: string | null;
	inReplyTo: string | null;
	/** The row as loaded when the scan started (null when there is none). */
	row: MirrorFields | null;
	/** Sessions alive in other tabs. */
	live: ReadonlySet<string>;
	now: number;
	/** What the composer shows now. */
	onScreen: () => MirrorFields;
	/** The row as observed now (re-checked inside each conditional delete). */
	latestRow: () => MirrorFields | null;
	/** False once the scan was superseded or the composer moved on. */
	stillCurrent: () => boolean;
}

function offerOf(record: MirrorCopyRecord): MirrorOffer {
	return {
		source: { kind: 'v2', record },
		fields: record.copy.fields,
		base: record.copy.base,
		...(record.copy.present ? { present: record.copy.present } : {}),
		savedAt: record.copy.savedAt,
	};
}

function sameMask(a?: readonly string[], b?: readonly string[]): boolean {
	return (a ?? []).join() === (b ?? []).join();
}

/** Every copy this composer may offer; cleans up what is safe to on the way. */
export async function scanMirrorOffers(
	store: PostboxDraftMirrorStore,
	scan: MirrorScan
): Promise<MirrorOffer[]> {
	const { ns, row } = scan;
	const candidates: MirrorOffer[] = [];
	const records =
		scan.draftId === null
			? (await store.list(ns)).filter(
					(r) => r.copy.draftId === null && r.copy.inReplyTo === scan.inReplyTo
				)
			: await store.list(ns, scan.draftId);
	for (const record of records) {
		if (record.sessionId === scan.sessionId || scan.live.has(record.sessionId)) continue;
		if (isMirrorCopyExpired(record.copy.savedAt, scan.now)) {
			await store.removeIfUnchanged(record.key, record.copy, scan.stillCurrent);
			continue;
		}
		if (row && copyMatches(record.copy, row)) {
			// Already on the server (G1a), judged against the row as it is NOW.
			await store.removeIfUnchanged(record.key, record.copy, () => {
				const latest = scan.latestRow();
				return scan.stillCurrent() && latest !== null && copyMatches(record.copy, latest);
			});
			continue;
		}
		if (copyMatches(record.copy, scan.onScreen())) continue;
		// The same text in several copies (a parked one and a tab's live one) is
		// one offer: the newest stands for it, the others ride along as twins.
		const same = candidates.find(
			(c) =>
				c.source.kind === 'v2' &&
				sameMask(c.present, record.copy.present) &&
				copyMatches(record.copy, c.fields)
		);
		if (same?.source.kind === 'v2') {
			const [newer, older] =
				record.copy.savedAt > same.savedAt
					? [record, same.source.record]
					: [same.source.record, record];
			Object.assign(same, offerOf(newer), { twins: [...(same.twins ?? []), older] });
			continue;
		}
		candidates.push(offerOf(record));
	}

	const legacyIds =
		scan.draftId === null
			? [scan.inReplyTo ? `new-reply:${scan.inReplyTo}` : 'new']
			: [scan.draftId];
	for (const id of legacyIds) {
		const legacy = await store.readLegacy(ns, id);
		if (!legacy) continue;
		const fields = mirrorFieldsOfLegacy(legacy.entry);
		if (row && mirrorFieldsEqual(fields, row)) {
			// Judged against the row as it is NOW, inside the delete (G1a).
			await store.removeLegacy(legacy, () => {
				const latest = scan.latestRow();
				return scan.stillCurrent() && latest !== null && mirrorFieldsEqual(fields, latest);
			});
			continue;
		}
		if (isBlankMirrorFields(fields) || mirrorFieldsEqual(fields, scan.onScreen())) continue;
		candidates.push({
			source: { kind: 'legacy', record: legacy },
			fields,
			base: null,
			savedAt: legacy.entry.savedAt,
		});
	}
	return candidates;
}
