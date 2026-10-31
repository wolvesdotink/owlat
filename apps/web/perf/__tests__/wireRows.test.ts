/**
 * The scenarios' simulated wire decodes every row it parses, and hands the
 * parsed array on as it is: structural sharing must still keep the identity of
 * every row a delivery did not change.
 */
import { describe, expect, it } from 'vitest';
import { shareStructure } from '~/lib/structuralSharing';
import {
	firstUnread,
	markRead,
	markThreadRead,
	postboxListWorkload,
	teamInboxWorkload,
} from '../listWorkload';
import { SCENARIOS } from '../scenarios';
import { assistantStreamWorkload, chatHistoryWorkload } from '../workload';
import {
	decodeAssistantRows,
	decodeChatRows,
	decodeInboxThreads,
	decodePostboxRows,
} from '../wireRows';

const wire = (rows: unknown): unknown => JSON.parse(JSON.stringify(rows));

function scenario<F extends (typeof SCENARIOS)[number]['family']>(family: F) {
	const found = SCENARIOS.find((s) => s.family === family);
	if (!found) throw new Error(`no ${family} scenario`);
	return found as Extract<(typeof SCENARIOS)[number], { family: F }>;
}

const assistantRows = assistantStreamWorkload(scenario('assistant-stream')).history;
const chatRows = chatHistoryWorkload(scenario('chat-history'));
const postboxRows = postboxListWorkload(scenario('postbox-list'));
const inboxThreads = teamInboxWorkload(scenario('team-inbox'));

describe('wire row decoders', () => {
	it.each([
		['assistant', decodeAssistantRows, assistantRows],
		['chat', decodeChatRows, chatRows],
		['postbox', decodePostboxRows, postboxRows],
		['team inbox', decodeInboxThreads, inboxThreads],
	] as const)(
		'accepts every %s row the workload sends, as the same array',
		(_label, decode, rows) => {
			const parsed = wire(rows);
			expect(rows.length).toBeGreaterThan(0);
			expect(decode(parsed)).toBe(parsed);
			expect(decode(parsed)).toEqual(rows);
		}
	);

	it.each<[string, (value: unknown) => unknown, unknown, string]>([
		['a payload that is not an array', decodePostboxRows, { rows: [] }, 'not an array'],
		['a null row', decodePostboxRows, [null], 'row 0: not an object'],
		[
			'a row with a mistyped field',
			decodePostboxRows,
			[{ ...postboxRows[0], flagSeen: 'yes' }],
			'row 0: field "flagSeen"',
		],
		[
			'a row with a mistyped optional field',
			decodePostboxRows,
			[postboxRows[0], { ...postboxRows[1], pinnedAt: 'today' }],
			'row 1: field "pinnedAt"',
		],
		[
			'an unknown status',
			decodeAssistantRows,
			[{ ...assistantRows[0], status: 'thinking' }],
			'row 0: field "status"',
		],
		[
			'a malformed nested tool call',
			decodeAssistantRows,
			[{ ...assistantRows[0], toolCalls: [{ status: 1 }] }],
			'row 0: field "toolCalls"',
		],
		[
			'a malformed nested author',
			decodeChatRows,
			[{ ...chatRows[0], author: { name: 'Ada', email: null } }],
			'row 0: field "author"',
		],
		[
			'a malformed nested assignee',
			decodeInboxThreads,
			[{ ...inboxThreads[0], assignee: { name: 'Ada', email: 'ada@example.com', image: '' } }],
			'row 0: field "assignee"',
		],
	])('refuses %s', (_label, decode, payload, message) => {
		expect(() => decode(wire(payload))).toThrow(message);
	});

	it('keeps every postbox row identity on an equal delivery and all but one on a patch', () => {
		const first = shareStructure(undefined, decodePostboxRows(wire(postboxRows)));
		const same = shareStructure(first, decodePostboxRows(wire(postboxRows)));
		expect(same).toBe(first);

		const changed = firstUnread(postboxRows);
		const patched = shareStructure(first, decodePostboxRows(wire(markRead(postboxRows, changed))));
		expect(patched).not.toBe(first);
		for (const [i, row] of patched.entries()) {
			if (i === changed) expect(row).not.toBe(first[i]);
			else expect(row).toBe(first[i]);
		}
		expect(patched[changed]?.flagSeen).toBe(true);
	});

	it('keeps every team inbox thread identity but the one a patch marks read', () => {
		const first = shareStructure(undefined, decodeInboxThreads(wire(inboxThreads)));
		expect(shareStructure(first, decodeInboxThreads(wire(inboxThreads)))).toBe(first);

		const changed = inboxThreads.findIndex((thread) => thread.unread);
		const patched = shareStructure(
			first,
			decodeInboxThreads(wire(markThreadRead(inboxThreads, changed)))
		);
		for (const [i, thread] of patched.entries()) {
			if (i === changed) expect(thread).not.toBe(first[i]);
			else expect(thread).toBe(first[i]);
		}
	});
});
