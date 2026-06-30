/**
 * Reactive Postbox search wrapper.
 *
 * Parses the user's free-form query into operators (`from:` / `is:` /
 * `before:` etc.) on the client, then hands the structured payload to
 * the Convex `mailMailbox.search` query.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface ParsedSearchQuery {
	text: string;
	from?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	flagSeen?: boolean;
	flagFlagged?: boolean;
	folderRole?: string;
	labelName?: string;
	beforeMs?: number;
	afterMs?: number;
}

function parseDuration(raw: string): number | null {
	const m = raw.match(/^(\d+)([dhm])$/);
	if (!m || m[1] === undefined || m[2] === undefined) return null;
	const n = parseInt(m[1], 10);
	const unit = m[2];
	if (unit === 'd') return n * 24 * 60 * 60 * 1000;
	if (unit === 'h') return n * 60 * 60 * 1000;
	if (unit === 'm') return n * 60 * 1000;
	return null;
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
	const result: ParsedSearchQuery = { text: '' };
	const remaining: string[] = [];
	for (const tok of input.trim().split(/\s+/)) {
		if (!tok) continue;
		const colon = tok.indexOf(':');
		if (colon < 0) {
			remaining.push(tok);
			continue;
		}
		const op = tok.slice(0, colon).toLowerCase();
		const val = tok.slice(colon + 1);
		if (!val) continue;
		switch (op) {
			case 'from':
				result.from = val.toLowerCase();
				break;
			case 'to':
				result.to = val.toLowerCase();
				break;
			case 'subject':
				result.subject = val.toLowerCase();
				break;
			case 'has':
				if (val === 'attachment') result.hasAttachment = true;
				else if (val === 'no-attachment') result.hasAttachment = false;
				else remaining.push(tok);
				break;
			case 'is':
				if (val === 'unread') result.flagSeen = false;
				else if (val === 'read') result.flagSeen = true;
				else if (val === 'starred' || val === 'flagged') result.flagFlagged = true;
				else remaining.push(tok);
				break;
			case 'in':
				result.folderRole = val.toLowerCase();
				break;
			case 'label':
				result.labelName = val.toLowerCase();
				break;
			case 'before': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) result.beforeMs = ts;
				else remaining.push(tok);
				break;
			}
			case 'after': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) result.afterMs = ts;
				else remaining.push(tok);
				break;
			}
			case 'older_than': {
				const dur = parseDuration(val);
				if (dur != null) result.beforeMs = Date.now() - dur;
				else remaining.push(tok);
				break;
			}
			case 'newer_than': {
				const dur = parseDuration(val);
				if (dur != null) result.afterMs = Date.now() - dur;
				else remaining.push(tok);
				break;
			}
			default:
				remaining.push(tok);
		}
	}
	result.text = remaining.join(' ').trim();
	return result;
}

export function usePostboxSearch(
	mailboxId: Ref<Id<'mailboxes'> | null>,
	query: Ref<string>
) {
	const parsed = computed(() => parseSearchQuery(query.value));

	const { data, isLoading } = useConvexQuery(api.mail.mailbox.search, () => {
		if (!mailboxId.value) return 'skip';
		const trimmed = query.value.trim();
		if (!trimmed) return 'skip';
		return {
			mailboxId: mailboxId.value,
			...parsed.value,
		};
	});

	const results = computed(() => data.value ?? []);
	return { parsed, results, isLoading };
}

/** Build human-readable filter chips from a parsed query. */
export function describeChips(parsed: ParsedSearchQuery): Array<{ key: string; label: string }> {
	const chips: Array<{ key: string; label: string }> = [];
	if (parsed.from) chips.push({ key: 'from', label: `from: ${parsed.from}` });
	if (parsed.to) chips.push({ key: 'to', label: `to: ${parsed.to}` });
	if (parsed.subject) chips.push({ key: 'subject', label: `subject: ${parsed.subject}` });
	if (parsed.hasAttachment === true) chips.push({ key: 'has', label: 'has: attachment' });
	if (parsed.hasAttachment === false) chips.push({ key: 'has', label: 'has: no attachment' });
	if (parsed.flagSeen === false) chips.push({ key: 'is', label: 'is: unread' });
	if (parsed.flagSeen === true) chips.push({ key: 'is', label: 'is: read' });
	if (parsed.flagFlagged === true) chips.push({ key: 'is', label: 'is: starred' });
	if (parsed.folderRole) chips.push({ key: 'in', label: `in: ${parsed.folderRole}` });
	if (parsed.labelName) chips.push({ key: 'label', label: `label: ${parsed.labelName}` });
	if (parsed.beforeMs)
		chips.push({ key: 'before', label: `before: ${new Date(parsed.beforeMs).toLocaleDateString()}` });
	if (parsed.afterMs)
		chips.push({ key: 'after', label: `after: ${new Date(parsed.afterMs).toLocaleDateString()}` });
	return chips;
}
