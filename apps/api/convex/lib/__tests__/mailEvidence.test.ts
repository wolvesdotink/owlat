/**
 * L2: every consumer's header and sender predicate, re-expressed on the shared
 * evidence (`lib/mailEvidence.ts`, `mail/senderEvidence.ts`), gives the same
 * answer as the implementation it replaced. The `previous*` functions below are
 * verbatim copies of the code before the change. They run side by side with
 * the live consumers over a header matrix and over every eval-corpus message.
 */
import { describe, expect, it } from 'vitest';
import { isAutomatedMail } from '../inboundClassification';
import {
	headerEvidenceFromMap,
	headerEvidenceFromStoredJson,
	headerEvidenceOf,
	isAutomatedForAttachments,
	isBulkHeaderForInterpretation,
	isLoopSuppressedMail,
} from '../mailEvidence';
import {
	evaluateNeedsReplyCandidate,
	isAutomatedByHeaders,
	isBulkOrNoReplySender,
	isInformationalSubject,
	isPublishingAddress,
	isUnattendedAddress,
} from '../../mail/needsReplyHeuristic';
import { classifyMailCategory } from '../../mail/category';
import { isScreenedOut } from '../../mail/ai/priorityScore';
import { isHeldOutByScreener, senderEvidenceOf } from '../../mail/senderEvidence';
import { loadCorpus } from '../../mail/interpret/__eval__/__tests__/corpusFixture';

// ── The previous implementations, verbatim ────────────────────────────────

function previousIsAutomatedMail(headers: Record<string, string>): boolean {
	const h: Record<string, string> = {};
	for (const [k, value] of Object.entries(headers)) h[k.toLowerCase()] = value;
	const norm = (s: string) => s.toLowerCase().trim();
	const autoSubmitted = h['auto-submitted'];
	if (autoSubmitted && norm(autoSubmitted) !== 'no') return true;
	if (h['list-id']) return true;
	const precedence = h['precedence'];
	if (precedence) {
		const p = norm(precedence);
		if (p === 'bulk' || p === 'list' || p === 'junk') return true;
	}
	if (h['x-owlat-forwarded']) return true;
	return false;
}

function previousIsAutomatedByHeaders(headers: {
	autoSubmitted?: string;
	listId?: string;
}): boolean {
	const autoSubmitted = headers.autoSubmitted?.trim().toLowerCase();
	if (autoSubmitted && autoSubmitted !== 'no') return true;
	return (headers.listId?.trim().length ?? 0) > 0;
}

const PREVIOUS_BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);
function previousIsBulkOrNoReplySender(msg: {
	fromAddress: string;
	hasListUnsubscribe: boolean;
	precedence?: string;
	replyToAddress?: string;
}): boolean {
	if (msg.hasListUnsubscribe) return true;
	const precedence = msg.precedence?.trim().toLowerCase();
	if (precedence && PREVIOUS_BULK_PRECEDENCE.has(precedence)) return true;
	if (msg.replyToAddress && isUnattendedAddress(msg.replyToAddress)) return true;
	return isUnattendedAddress(msg.fromAddress);
}

function previousCategoryBulkPrecedence(precedence?: string): boolean {
	const p = precedence?.trim().toLowerCase();
	return p === 'bulk' || p === 'list';
}

function previousEligibilityBulkPrecedence(precedence: string | undefined): boolean {
	return !!precedence && /^\s*(?:bulk|list|junk)\b/i.test(precedence);
}

function previousPostboxBulkHeader(opts: {
	hasUnsubscribe: boolean;
	precedence?: string;
	listId?: string;
}): boolean {
	return opts.hasUnsubscribe || previousEligibilityBulkPrecedence(opts.precedence) || !!opts.listId;
}

function previousInboundHeader(headersJson: string | undefined, name: string): string | undefined {
	if (!headersJson) return undefined;
	try {
		const parsed: unknown = JSON.parse(headersJson);
		const lower = name.toLowerCase();
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (Array.isArray(entry) && String(entry[0]).toLowerCase() === lower) {
					return String(entry[1]);
				}
				if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
					const pair = entry as { key: unknown; value: unknown };
					if (String(pair.key).toLowerCase() === lower) return String(pair.value);
				}
			}
			return undefined;
		}
		if (parsed && typeof parsed === 'object') {
			for (const [key, value] of Object.entries(parsed)) {
				if (key.toLowerCase() === lower)
					return Array.isArray(value) ? String(value[0]) : String(value);
			}
		}
	} catch {
		// Unparseable headers read as absent.
	}
	return undefined;
}

function previousTeamBulkHeader(headersJson: string | undefined): boolean {
	const precedence = previousInboundHeader(headersJson, 'precedence');
	return (
		previousInboundHeader(headersJson, 'list-unsubscribe') !== undefined ||
		previousInboundHeader(headersJson, 'list-id') !== undefined ||
		previousEligibilityBulkPrecedence(precedence)
	);
}

function previousIsScreenedOut(opts: {
	screenerEnabled: boolean;
	sender: { isVip?: boolean; accepted?: boolean; isKnownContact?: boolean };
}): boolean {
	if (!opts.screenerEnabled) return false;
	const s = opts.sender;
	if (s.isVip || s.accepted || s.isKnownContact) return false;
	return true;
}

type PreviousMessage = Parameters<typeof evaluateNeedsReplyCandidate>[0]['messages'][number];

function previousEvaluateNeedsReplyCandidate(opts: {
	ownerAddresses: string[];
	messages: PreviousMessage[];
	autoSubmitted?: string;
	listId?: string;
	precedence?: string;
}) {
	const owners = new Set(opts.ownerAddresses.map((a) => a.toLowerCase()));
	const ordered = opts.messages
		.map((m, index) => ({ m, index }))
		.sort((a, b) => a.m.receivedAt - b.m.receivedAt);
	let latestInbound: { m: PreviousMessage; index: number } | undefined;
	for (const entry of ordered) {
		if (!entry.m.isFromOwner && !owners.has(entry.m.fromAddress.toLowerCase())) {
			latestInbound = entry;
		}
	}
	if (!latestInbound) return { candidate: false, reason: 'no_inbound' };
	const ownerRepliedAfter = ordered.some(
		(e) =>
			(e.m.isFromOwner || owners.has(e.m.fromAddress.toLowerCase())) &&
			e.m.receivedAt >= latestInbound.m.receivedAt
	);
	if (ownerRepliedAfter) return { candidate: false, reason: 'owner_replied' };
	if (previousIsAutomatedByHeaders(opts)) return { candidate: false, reason: 'automated' };
	if (
		previousIsBulkOrNoReplySender({
			fromAddress: latestInbound.m.fromAddress,
			hasListUnsubscribe: latestInbound.m.hasListUnsubscribe,
			precedence: opts.precedence,
			replyToAddress: latestInbound.m.replyToAddress,
		})
	) {
		return { candidate: false, reason: 'bulk_sender' };
	}
	if (
		isPublishingAddress(latestInbound.m.fromAddress) &&
		isInformationalSubject(latestInbound.m.subject)
	) {
		return { candidate: false, reason: 'automated' };
	}
	const inTo = latestInbound.m.toAddresses.some((a) => owners.has(a.toLowerCase()));
	if (!inTo) return { candidate: false, reason: 'not_in_to' };
	return { candidate: true, latestInboundIndex: latestInbound.index };
}

// ── The header matrix ──────────────────────────────────────────────────────

const VALUES: Record<string, (string | undefined)[]> = {
	'auto-submitted': [undefined, '', '  ', 'no', ' No ', 'auto-replied', 'Auto-Generated'],
	'list-id': [undefined, '', '  ', '<news.example.com>'],
	precedence: [
		undefined,
		'',
		'bulk',
		' Bulk ',
		'list',
		'junk',
		'auto_reply',
		'first-class',
		'bulk; x',
		'listing',
	],
	'x-owlat-forwarded': [undefined, '', 'mbx_1'],
};

/** Every combination of the values above (7 × 4 × 10 × 3 = 840 maps). */
function headerMatrix(): Record<string, string>[] {
	let maps: Record<string, string>[] = [{}];
	for (const [name, values] of Object.entries(VALUES)) {
		const next: Record<string, string>[] = [];
		for (const map of maps) {
			for (const value of values) next.push(value === undefined ? map : { ...map, [name]: value });
		}
		maps = next;
	}
	return maps;
}

const MATRIX = headerMatrix();
/** Mixed-case keys, which the map readers must lowercase. */
const MIXED_CASE = MATRIX.map((m) =>
	Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toUpperCase(), v]))
);

describe('header evidence: each consumer keeps its predicate', () => {
	it('covers the whole matrix', () => {
		expect(MATRIX.length).toBe(840);
	});

	it('loop suppression (Team ingest, Postbox hooks, live knowledge)', () => {
		for (const headers of [...MATRIX, ...MIXED_CASE]) {
			expect(isAutomatedMail(headers), JSON.stringify(headers)).toBe(
				previousIsAutomatedMail(headers)
			);
		}
	});

	it('reply candidacy: the machine-generated headers and the bulk precedence', () => {
		for (const h of MATRIX) {
			const headers = {
				...(h['auto-submitted'] !== undefined ? { autoSubmitted: h['auto-submitted'] } : {}),
				...(h['list-id'] !== undefined ? { listId: h['list-id'] } : {}),
			};
			expect(isAutomatedByHeaders(headers), JSON.stringify(h)).toBe(
				previousIsAutomatedByHeaders(headers)
			);
			for (const hasListUnsubscribe of [false, true]) {
				for (const fromAddress of ['ana@example.com', 'no-reply@example.com']) {
					const msg = {
						fromAddress,
						hasListUnsubscribe,
						...(h['precedence'] !== undefined ? { precedence: h['precedence'] } : {}),
					};
					expect(isBulkOrNoReplySender(msg), JSON.stringify(msg)).toBe(
						previousIsBulkOrNoReplySender(msg)
					);
				}
			}
		}
	});

	it('category: Precedence bulk|list only', () => {
		for (const precedence of VALUES.precedence!) {
			for (const fromAddress of ['ana@example.com', 'alerts@example.com']) {
				const input = {
					fromAddress,
					subject: 'Hello',
					hasListUnsubscribe: false,
					isKnownCorrespondent: true,
					...(precedence !== undefined ? { precedence } : {}),
				};
				const isNewsletter = classifyMailCategory(input) === 'newsletter';
				expect(isNewsletter, JSON.stringify(input)).toBe(
					previousCategoryBulkPrecedence(precedence)
				);
			}
		}
	});

	it('interpretation, Postbox: List-Unsubscribe, a non-empty List-Id, a bulk Precedence', () => {
		for (const h of MATRIX) {
			for (const hasUnsubscribe of [false, true]) {
				const args = {
					hasUnsubscribe,
					...(h['precedence'] !== undefined ? { precedence: h['precedence'] } : {}),
					...(h['list-id'] !== undefined ? { listId: h['list-id'] } : {}),
				};
				const evidence = headerEvidenceOf({
					...(args.precedence !== undefined ? { precedence: args.precedence } : {}),
					...(args.listId !== undefined ? { listId: args.listId } : {}),
					hasListUnsubscribe: hasUnsubscribe,
				});
				expect(isBulkHeaderForInterpretation(evidence, 'non_empty'), JSON.stringify(args)).toBe(
					previousPostboxBulkHeader(args)
				);
			}
		}
	});

	it('interpretation, Team Inbox: any stored List-Unsubscribe or List-Id, a bulk Precedence', () => {
		const shapes = (h: Record<string, string>) => [
			JSON.stringify(h),
			JSON.stringify(Object.entries(h)),
			JSON.stringify(Object.entries(h).map(([key, value]) => ({ key, value }))),
			JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, [v, 'second']]))),
		];
		const withUnsubscribe = MATRIX.flatMap((h) => [h, { ...h, 'List-Unsubscribe': '<mailto:x>' }]);
		for (const h of withUnsubscribe) {
			for (const json of shapes(h)) {
				expect(
					isBulkHeaderForInterpretation(headerEvidenceFromStoredJson(json), 'present'),
					json
				).toBe(previousTeamBulkHeader(json));
			}
		}
		for (const json of [undefined, '', 'not json', 'null', '42']) {
			expect(isBulkHeaderForInterpretation(headerEvidenceFromStoredJson(json), 'present')).toBe(
				previousTeamBulkHeader(json)
			);
		}
	});

	it('keeps X-Owlat-Forwarded a loop signal and not a reply or attachment signal', () => {
		const forwarded = headerEvidenceFromMap({ 'x-owlat-forwarded': 'mbx_1' });
		expect(isLoopSuppressedMail(forwarded)).toBe(true);
		expect(isAutomatedByHeaders({})).toBe(false);
		expect(isAutomatedForAttachments(forwarded)).toBe(false);
	});
});

describe('sender evidence: each consumer keeps its predicate', () => {
	const rows = [
		null,
		{ useCount: 0 },
		{ useCount: 3 },
		{ useCount: 0, isVip: true },
		{ useCount: 0, isScreenerAccepted: true },
		{ useCount: 0, isScreenerAccepted: false, isVip: false },
	];

	it('category reads address-book membership, eligibility prior correspondence', () => {
		for (const row of rows) {
			const evidence = senderEvidenceOf(row);
			expect(evidence.isInAddressBook).toBe(row !== null);
			expect(evidence.hasCorresponded).toBe((row?.useCount ?? 0) > 0);
		}
	});

	it('the screener holds out the same senders as before', () => {
		const signals = [
			{},
			{ isVip: true },
			{ accepted: true },
			{ isKnownContact: true },
			{ isVip: false, accepted: false, isKnownContact: false },
		];
		for (const screenerEnabled of [false, true]) {
			for (const sender of signals) {
				expect(isScreenedOut({ screenerEnabled, sender })).toBe(
					previousIsScreenedOut({ screenerEnabled, sender })
				);
			}
			for (const row of rows) {
				const sender = senderEvidenceOf(row);
				const signal = row
					? {
							isVip: row.isVip === true,
							accepted: row.isScreenerAccepted === true,
							isKnownContact: true,
						}
					: {};
				expect(isHeldOutByScreener({ screenerEnabled, sender })).toBe(
					previousIsScreenedOut({ screenerEnabled, sender: signal })
				);
			}
		}
	});
});

describe('the eval corpus: every message decides as before', () => {
	const corpus = loadCorpus();

	it('reply candidacy, category, interpretation and loop suppression', () => {
		let checked = 0;
		for (const thread of corpus) {
			for (const message of thread.messages) {
				const headers = message.headers ?? {};
				const precedence = headers.precedence;
				const hasListUnsubscribe = headers.listUnsubscribe === true;
				const map: Record<string, string> = precedence !== undefined ? { precedence } : {};
				expect(isAutomatedMail(map)).toBe(previousIsAutomatedMail(map));
				const bulkArgs = {
					fromAddress: message.from.email,
					hasListUnsubscribe,
					...(precedence !== undefined ? { precedence } : {}),
				};
				expect(isBulkOrNoReplySender(bulkArgs)).toBe(previousIsBulkOrNoReplySender(bulkArgs));
				expect(
					isBulkHeaderForInterpretation(
						headerEvidenceOf({
							...(precedence !== undefined ? { precedence } : {}),
							hasListUnsubscribe,
						}),
						'non_empty'
					)
				).toBe(
					previousPostboxBulkHeader({
						hasUnsubscribe: hasListUnsubscribe,
						...(precedence !== undefined ? { precedence } : {}),
					})
				);
				for (const isKnownCorrespondent of [false, true]) {
					const category = classifyMailCategory({
						fromAddress: message.from.email,
						subject: message.subject,
						hasListUnsubscribe,
						isKnownCorrespondent,
						...(precedence !== undefined ? { precedence } : {}),
					});
					const wasNewsletter = hasListUnsubscribe || previousCategoryBulkPrecedence(precedence);
					if (wasNewsletter) expect(category).toBe('newsletter');
					else expect(category).not.toBe('newsletter');
				}
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(100);
	});

	it('the needs-reply screen gives the same verdict on every corpus thread', () => {
		const headerCases = [
			{},
			{ autoSubmitted: 'auto-generated' },
			{ autoSubmitted: '  ' },
			{ listId: '<list.example.com>' },
			{ listId: '' },
		];
		let checked = 0;
		for (const thread of corpus) {
			const owner = thread.messages.find((m) => m.direction === 'outbound')?.from.email;
			const ownerAddresses = [owner ?? thread.messages[0]!.to[0]?.email ?? 'owner@example.com'];
			const messages = thread.messages.map((m, i) => ({
				fromAddress: m.from.email,
				toAddresses: m.to.map((p) => p.email),
				ccAddresses: (m.cc ?? []).map((p) => p.email),
				hasListUnsubscribe: m.headers?.listUnsubscribe === true,
				isFromOwner: m.direction === 'outbound',
				receivedAt: i,
				subject: m.subject,
			}));
			const precedence = thread.messages[thread.messages.length - 1]?.headers?.precedence;
			for (const headers of headerCases) {
				const opts = {
					ownerAddresses,
					messages,
					...headers,
					...(precedence !== undefined ? { precedence } : {}),
				};
				expect(evaluateNeedsReplyCandidate(opts), thread.id).toEqual(
					previousEvaluateNeedsReplyCandidate(opts)
				);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(400);
	});
});
