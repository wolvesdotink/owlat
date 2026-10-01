/**
 * Mailchimp integration import provider adapter.
 *
 * Owns the Mailchimp-side surface of one **Integration import** run —
 * config validation, HTTP fetch, response parsing, and normalization
 * into `ImportRow[]` for the **Contact import (module)**.
 *
 * Cursor convention: empty string is the first-page sentinel; otherwise
 * the cursor is a {@link MailchimpCursor} in JSON. A bare numeric cursor is
 * an `offset` from a run the previous release started, which finishes the
 * way it began. Terminal page returns `nextCursor: null`.
 *
 * Per ADR-0027.
 */

import {
	fetchProviderPage,
	type FetchPageResult,
	type IntegrationImportProviderModule,
	type SuppressionRow,
} from '../../_common';
import type { ImportRow } from '../../../contacts/import';
import { bytesToHex, utf8Bytes, utf8ToBase64 } from '../../../lib/bytes';

const PAGE_SIZE = 100;

interface MailchimpMember {
	email_address: string;
	status: string;
	merge_fields?: {
		FNAME?: string;
		LNAME?: string;
		[key: string]: string | undefined;
	};
}

interface MailchimpListResponse {
	members: MailchimpMember[];
	total_items: number;
}

/** Mailchimp's problem-details error body. */
interface MailchimpErrorBody {
	detail?: string;
	title?: string;
}

/**
 * Members each page re-reads from before the previous page's end. Removing a
 * member the walk has passed moves everyone after it one place up; this many
 * removals between two requests still leave no one between the pages.
 */
export const PAGE_OVERLAP = 20;

/**
 * Taken off the walk's start time for the closing pass, so a change Mailchimp
 * stamps slightly before our clock reads it is still included. Members changed
 * in that margin are read twice, which the contact import absorbs.
 */
const SINCE_MARGIN_MS = 5 * 60 * 1000;

/**
 * Where a run stands. An audience is a live list that keeps changing while the
 * pages are fetched minutes apart, so plain offset paging can skip a member
 * (one removed from a page already read moves the next one back across the
 * boundary) and never sees a change to a member it has passed. Three things
 * close that:
 *
 *  - `audience` pass: every member in signup order, so new signups land at the
 *    end instead of shifting members already read.
 *  - Each page re-reads {@link PAGE_OVERLAP} members before `offset` and starts
 *    after `last`, the previous page's final member, wherever that member now
 *    sits. If `last` is gone too, the whole window is imported; repeats are
 *    free (the contact import dedupes by email).
 *  - `changed` pass: once the audience is read, the members changed since
 *    `since` (the walk's start), in change order. That carries over a member
 *    who unsubscribed or was cleaned after its page was read, and any signup
 *    the first pass placed before its position.
 */
interface MailchimpCursor {
	pass: 'audience' | 'changed';
	/** Position just past the last member read, in this pass's order. */
	offset: number;
	/** Mailchimp timestamp (ISO 8601) the `changed` pass reads from. */
	since: string;
	/** {@link memberKey} of the last member read; absent on a pass's first page. */
	last?: string;
}

/** Previous release's cursor: the numeric offset of an unsorted walk. */
const LEGACY_OFFSET_CURSOR = /^\d+$/;

function parseCursor(cursor: string): MailchimpCursor | number {
	if (cursor === '') {
		const since = new Date(Date.now() - SINCE_MARGIN_MS).toISOString();
		// Mailchimp's own form, `2015-10-21T15:41:36+00:00`.
		return { pass: 'audience', offset: 0, since: since.replace(/\.\d{3}Z$/, '+00:00') };
	}
	if (LEGACY_OFFSET_CURSOR.test(cursor)) return parseInt(cursor, 10);
	let parsed: Partial<MailchimpCursor> | null = null;
	try {
		parsed = JSON.parse(cursor) as Partial<MailchimpCursor> | null;
	} catch {
		// Reported below like any other cursor this adapter did not write.
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		(parsed.pass !== 'audience' && parsed.pass !== 'changed') ||
		typeof parsed.offset !== 'number' ||
		typeof parsed.since !== 'string'
	) {
		throw new Error(`Unrecognized Mailchimp import cursor: ${cursor}`);
	}
	return parsed as MailchimpCursor;
}

/**
 * Identifies a member in a cursor without putting the address there: the
 * cursor shows up in run errors and logs.
 */
async function memberKey(member: MailchimpMember): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		utf8Bytes(member.email_address.toLowerCase())
	);
	return bytesToHex(digest).slice(0, 16);
}

/**
 * What one non-subscribed audience member means for Owlat's suppression state, or `null` when it
 * means nothing.
 *
 * NO SECOND FETCH IS NEEDED, and that is the whole shape of this feature on the
 * Mailchimp side. `GET /lists/{id}/members` is not status-filtered here: every
 * page the contacts import already walks carries the audience's `unsubscribed`
 * and `cleaned` members too, and the importer's only use for them until now was
 * to `continue` past them. So the carry-over adds no request of its own (the
 * closing pass over members changed during the run serves contacts and
 * suppressions alike) — it routes rows that were already on the wire and were
 * being dropped.
 *
 *  - `unsubscribed` — a departure. Routed to the CONSENT path, not the
 *    blocklist: Owlat has membership deletes, an opt-out stamp, campaign
 *    counters and a `topic.unsubscribed` webhook for this, and a blocklist row
 *    would record the outcome while skipping all of it.
 *  - `cleaned` — Mailchimp's word for "this address hard-bounced (or repeatedly
 *    failed) and we stopped mailing it". Mailbox evidence, and the strongest
 *    kind: `bounced`/`hard`, which the MTA mirror makes a permanent backstop
 *    entry.
 *  - `pending` (double opt-in in flight), `transactional`, `archived`, and any
 *    status Mailchimp adds later — NOT suppressions. A pending member has not
 *    said no, and an archived one is an audience-management decision about a
 *    list, not a statement about the mailbox. Suppressing on either would let a
 *    tidy-up in Mailchimp permanently silence an address here. They are counted
 *    as skipped so the run summary accounts for every member the page saw.
 */
function suppressionForStatus(member: MailchimpMember): SuppressionRow | null {
	const email = member.email_address.toLowerCase();
	if (member.status === 'unsubscribed') {
		return { email, reason: 'unsubscribe', evidence: 'unsubscribed' };
	}
	if (member.status === 'cleaned') {
		return { email, reason: 'bounced', bounceType: 'hard', evidence: 'cleaned' };
	}
	return null;
}

export const mailchimpProvider: IntegrationImportProviderModule<'mailchimp'> = {
	kind: 'mailchimp',
	contactSource: 'mailchimp',
	defaultDoiAttest: 'mailchimp',

	validateConfig(config) {
		const datacenter = config.apiKey.split('-').pop();
		// Strict format check: Mailchimp datacenters are always two letters +
		// digits (e.g. us21, eu1). Anything else — including wildcard-DNS
		// payloads like "1.2.3.4.nip.io" — would let a malicious key steer
		// the Convex action's HTTP request toward an attacker-chosen host.
		if (!datacenter || !/^[a-z]{2}\d+$/.test(datacenter)) {
			return {
				ok: false,
				reason:
					'Invalid Mailchimp API key format. Expected format: apikey-datacenter (e.g., abc123-us21)',
			};
		}
		if (!config.listId) {
			return { ok: false, reason: 'Mailchimp listId is required' };
		}
		return { ok: true };
	},

	async fetchPage({ config, cursor }): Promise<FetchPageResult> {
		const position = parseCursor(cursor);
		const datacenter = config.apiKey.split('-').pop();
		if (!datacenter || !/^[a-z]{2}\d+$/.test(datacenter)) {
			throw new Error(
				'Invalid Mailchimp API key format. Expected format: apikey-datacenter (e.g., abc123-us21)'
			);
		}

		const params = new URLSearchParams();
		let offset: number;
		let count = PAGE_SIZE;
		if (typeof position === 'number') {
			offset = position;
		} else {
			offset =
				position.last === undefined ? position.offset : Math.max(0, position.offset - PAGE_OVERLAP);
			count += position.offset - offset;
			if (position.pass === 'audience') {
				params.set('sort_field', 'timestamp_signup');
			} else {
				params.set('since_last_changed', position.since);
				params.set('sort_field', 'last_changed');
			}
			params.set('sort_dir', 'ASC');
		}
		const order = params.toString();
		const url =
			`https://${datacenter}.api.mailchimp.com/3.0/lists/${config.listId}/members` +
			`?count=${count}&offset=${offset}` +
			(order === '' ? '' : `&${order}`) +
			`&fields=members.email_address,members.status,members.merge_fields,total_items`;

		const response = await fetchProviderPage<MailchimpErrorBody>(
			url,
			{
				method: 'GET',
				headers: {
					Authorization: `Basic ${utf8ToBase64(`anystring:${config.apiKey}`)}`,
					'Content-Type': 'application/json',
				},
			},
			{
				label: 'Mailchimp',
				where: `at offset ${offset}`,
				extractMessage: (body) => body.detail || body.title,
				secret: config.apiKey,
			}
		);

		const data = (await response.json()) as MailchimpListResponse;
		const isPassOver = data.members.length < count;
		let members = data.members;
		if (typeof position !== 'number' && position.last !== undefined) {
			const keys = await Promise.all(members.map(memberKey));
			members = members.slice(keys.indexOf(position.last) + 1);
		}

		// Extract subscribed contacts. Mailchimp's `merge_fields` carries
		// customer-defined keys beyond FNAME/LNAME (COMPANY, TIER, etc.);
		// we pluck the name fields into `firstName`/`lastName` and pass the
		// rest through as `properties` — the **Contact import (module)**
		// auto-registers unknown property keys on `mailchimp` source.
		const rows: ImportRow[] = [];
		const suppressions: SuppressionRow[] = [];
		let suppressionsSkipped = 0;
		for (const member of members) {
			if (member.status !== 'subscribed') {
				if (config.importSuppressions) {
					const carried = suppressionForStatus(member);
					if (carried) suppressions.push(carried);
					else suppressionsSkipped++;
				}
				continue;
			}
			const mergeFields = member.merge_fields ?? {};
			const properties: Record<string, string | number | boolean | null> = {};
			for (const [key, value] of Object.entries(mergeFields)) {
				if (key === 'FNAME' || key === 'LNAME') continue;
				if (value == null || value === '') continue;
				properties[key] = value;
			}
			rows.push({
				email: member.email_address.toLowerCase(),
				firstName: mergeFields.FNAME,
				lastName: mergeFields.LNAME,
				...(Object.keys(properties).length > 0 ? { properties } : {}),
			});
		}

		return {
			rows,
			nextCursor: await nextCursorAfter(position, offset, data.members, isPassOver),
			// The closing pass's total is only the changed members.
			...(typeof position === 'number' || position.pass === 'audience'
				? { totalEstimate: data.total_items }
				: {}),
			...(suppressions.length > 0 ? { suppressions } : {}),
			...(suppressionsSkipped > 0 ? { suppressionsSkipped } : {}),
		};
	},
};

async function nextCursorAfter(
	position: MailchimpCursor | number,
	offset: number,
	page: MailchimpMember[],
	isPassOver: boolean
): Promise<string | null> {
	if (typeof position === 'number') {
		return isPassOver ? null : String(offset + PAGE_SIZE);
	}
	const lastMember = page.at(-1);
	if (!isPassOver && lastMember !== undefined) {
		const next: MailchimpCursor = {
			pass: position.pass,
			offset: offset + page.length,
			since: position.since,
			last: await memberKey(lastMember),
		};
		return JSON.stringify(next);
	}
	// An audience read in one request had no time to change under it.
	const isSinglePage = position.pass === 'audience' && position.last === undefined;
	if (position.pass === 'changed' || isSinglePage) return null;
	const closing: MailchimpCursor = { pass: 'changed', offset: 0, since: position.since };
	return JSON.stringify(closing);
}
