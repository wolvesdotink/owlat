/**
 * Contact import: the per-batch and per-row decisions of `contacts/import.ts:
 * importBatch`, as data. The mutation resolves contacts, writes properties,
 * activities, DOI attests and topic memberships; these functions say which
 * email a row resolves, what each row and the batch answer, which activity a
 * row records and which contacts each topic subscribes.
 */

import type { Id } from '../_generated/dataModel';
import type { RecordContactActivityArgs } from '../contactActivities/writer';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';

export type ImportRow = {
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	properties?: Record<string, string | number | boolean | null>;
};

export type TopicAssignments =
	| { kind: 'single'; topicId: Id<'topics'> }
	| { kind: 'per_row'; map: Record<string, Id<'topics'>[]> };

export type ImportOutcome = {
	imported: number;
	updated: number;
	skipped: number;
	failed: number;
	errors: string[];
	addedToTopics: number;
	propertiesSet: number;
	propertiesAutoRegistered: number;
	propertiesSkipped: number;
	activitiesRecorded: number;
};

/** Errors past this many are counted but not listed. */
const ERROR_CAP = 50;

/** The answer before any row ran: within-batch duplicates count as skipped. */
export function emptyImportOutcome(withinBatchDuplicates: number): ImportOutcome {
	return {
		imported: 0,
		updated: 0,
		skipped: withinBatchDuplicates,
		failed: 0,
		errors: [],
		addedToTopics: 0,
		propertiesSet: 0,
		propertiesAutoRegistered: 0,
		propertiesSkipped: 0,
		activitiesRecorded: 0,
	};
}

/** List an error on the outcome while the list has room. */
export function noteImportError(outcome: ImportOutcome, message: string): void {
	if (outcome.errors.length < ERROR_CAP) outcome.errors.push(message);
}

/**
 * The address a row resolves on, or why it fails. Mailchimp/Stripe rows come
 * in already lowercased; CSV/API may not, so every row is normalised first.
 */
export function rowEmail(row: ImportRow): { email: string } | { error: string } {
	const email = row.email ? normalizeEmail(row.email) : undefined;
	if (!email || !isValidEmail(email)) return { error: `Invalid email: ${row.email ?? '(empty)'}` };
	return { email };
}

/** Count one resolved row by what resolution did with it. */
export function countResolution(outcome: ImportOutcome, action: string): void {
	if (action === 'created') outcome.imported++;
	else if (action === 'updated') outcome.updated++;
	else outcome.skipped++;
}

/** Fold one row's property writes into the outcome and the skipped-key tally. */
export function countRowProperties(
	outcome: ImportOutcome,
	summary: { written: number; autoRegistered: number; skippedKeys: string[] },
	skippedKeyCounts: Map<string, number>
): void {
	outcome.propertiesSet += summary.written;
	outcome.propertiesAutoRegistered += summary.autoRegistered;
	for (const key of summary.skippedKeys) {
		skippedKeyCounts.set(key, (skippedKeyCounts.get(key) ?? 0) + 1);
		outcome.propertiesSkipped++;
	}
}

type ImportActivity = Extract<
	RecordContactActivityArgs,
	{ literal: 'created' | 'property_updated' }
>;

/**
 * The activity a row records: a new contact gets one `created` row; an
 * existing contact that received property writes gets one `property_updated`
 * row for all of them (one row per import, not per property, to keep the
 * timeline quiet). Its key is the row's first non-empty property key, the
 * representative of a summary-level row.
 */
export function rowActivity(
	action: string,
	row: ImportRow,
	propertiesWritten: number,
	contactId: Id<'contacts'>,
	now: number
): ImportActivity | null {
	if (action === 'created') {
		return { literal: 'created', contactId, metadata: { source: 'import' }, occurredAt: now };
	}
	if (propertiesWritten === 0) return null;
	const propertyKey =
		Object.keys(row.properties ?? {}).find((key) => {
			const value = row.properties?.[key];
			return value !== null && value !== undefined && value !== '';
		}) ?? 'properties';
	return {
		literal: 'property_updated',
		contactId,
		metadata: { propertyKey, newValue: `${propertiesWritten} value(s) updated` },
		occurredAt: now,
	};
}

/** The DOI admin-attest edge a row takes when the batch carries an attest. */
export function doiAttestInput(
	doiAttest: { attestSource: string; triggeredBy?: string },
	now: number
) {
	return {
		to: 'confirmed' as const,
		at: now,
		source: 'admin_attest' as const,
		attestSource: doiAttest.attestSource,
		...(doiAttest.triggeredBy ? { triggeredBy: doiAttest.triggeredBy } : {}),
	};
}

/**
 * The batch-level summary lines for property keys dropped across rows
 * (CSV/API only), e.g. "Property 'COMPANY' is not registered; values dropped
 * for 5 row(s)."
 */
export function noteSkippedKeys(
	outcome: ImportOutcome,
	skippedKeyCounts: ReadonlyMap<string, number>
): void {
	for (const [key, count] of skippedKeyCounts.entries()) {
		noteImportError(
			outcome,
			`Property '${key}' is not registered; values dropped for ${count} row(s).`
		);
	}
}

/**
 * Build per-topic contact-id lists from the `topicAssignments` input. The
 * `single` shape produces a one-entry map keyed by the single topicId; the
 * `per_row` shape coalesces per email → topicIds.
 *
 * `subscribeMany` is called once per distinct topic — the per-call coalescing
 * keeps the `cachedMemberCount` patch to one DB write per topic.
 */
export function buildPerTopicLists(
	assignments: TopicAssignments,
	contactEmailById: ReadonlyMap<Id<'contacts'>, string>
): Map<Id<'topics'>, Id<'contacts'>[]> {
	const perTopic = new Map<Id<'topics'>, Id<'contacts'>[]>();
	if (assignments.kind === 'single') {
		const allContactIds = Array.from(contactEmailById.keys());
		if (allContactIds.length > 0) {
			perTopic.set(assignments.topicId, allContactIds);
		}
		return perTopic;
	}
	for (const [contactId, email] of contactEmailById.entries()) {
		const topicIds = assignments.map[email];
		if (!topicIds || topicIds.length === 0) continue;
		for (const topicId of topicIds) {
			const list = perTopic.get(topicId) ?? [];
			list.push(contactId);
			perTopic.set(topicId, list);
		}
	}
	return perTopic;
}

/** Memberships a topic subscription added: active ones and those waiting for DOI. */
export function countAddedToTopic(
	outcomes: ReadonlyArray<{ ok: boolean; action?: string }>
): number {
	return outcomes.filter(
		(sub) => sub.ok && (sub.action === 'subscribed' || sub.action === 'pending_doi')
	).length;
}
