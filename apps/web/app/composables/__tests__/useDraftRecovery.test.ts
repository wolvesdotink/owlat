/**
 * Reading the device copies other editors of a draft left behind
 * (`useDraftRecovery.ts`): which are candidates, whether their editor is still
 * open, and whether they say what the editor shows. What happens to them is
 * the session's decision (`draftSession.test.ts`, `useDraftAutosave.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { createEditorDraftStore, editorDraftKey } from '~/utils/editorDraftStore';
import type { EditorDraftWriters } from '~/utils/editorDraftWriters';
import type { DraftLiveness } from '~/utils/draftSession';
import { createNoopDriver } from '~/utils/postboxOfflineKvDriver';
import { readDraftCandidates } from '../useDraftRecovery';

const SCOPE = 'editor-draft:v1:user_1:org_1:campaign:cmp_1:';
const NOW = Date.now();
const isText = (data: unknown): data is { text: string } =>
	typeof (data as { text?: unknown } | null)?.text === 'string';

function storeWith(entries: Record<string, unknown>) {
	const data = new Map(Object.entries(entries));
	return createEditorDraftStore({
		...createNoopDriver(),
		persistent: true,
		get: async <T>(key: string) => data.get(key) as T,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
	});
}

const writersWith = (liveness: Record<string, DraftLiveness>): EditorDraftWriters => ({
	open: () => ({ id: 'tab-a.1', close: () => {} }),
	liveness: async () => (writerId) => liveness[writerId] ?? 'closed',
});

const copyOf = (text: string, age: number, token = `t${age}`) => ({
	v: 2,
	token,
	seq: 1,
	savedAt: NOW - age,
	base: 4,
	data: { text },
});

describe('readDraftCandidates', () => {
	it("lists other editors' copies newest first, with their liveness and whether they match", async () => {
		const store = storeWith({
			[editorDraftKey(SCOPE, 'tab-a.1')]: copyOf('own', 1),
			[editorDraftKey(SCOPE, 'tab-b.1')]: copyOf('shown', 9),
			[editorDraftKey(SCOPE, 'tab-c.1')]: copyOf('theirs', 5),
		});
		const kept = new Map<string, { text: string }>();
		const candidates = await readDraftCandidates(
			{
				store,
				writers: writersWith({ 'tab-c.1': 'unknown' }),
				own: 'tab-a.1',
				accept: isText,
				matches: (data) => data.text === 'shown',
			},
			SCOPE,
			(token, data) => kept.set(token, data)
		);
		expect(candidates).toEqual([
			{
				key: editorDraftKey(SCOPE, 'tab-c.1'),
				token: 't5',
				liveness: 'unknown',
				savedAt: NOW - 5,
				base: 4,
				matches: false,
			},
			{
				key: editorDraftKey(SCOPE, 'tab-b.1'),
				token: 't9',
				liveness: 'closed',
				savedAt: NOW - 9,
				base: 4,
				matches: true,
			},
		]);
		expect(kept.get('t5')).toEqual({ text: 'theirs' });
	});

	it('finds nothing without copies', async () => {
		const candidates = await readDraftCandidates(
			{
				store: storeWith({}),
				writers: writersWith({}),
				own: 'tab-a.1',
				accept: isText,
				matches: () => false,
			},
			SCOPE,
			() => {}
		);
		expect(candidates).toEqual([]);
	});
});
