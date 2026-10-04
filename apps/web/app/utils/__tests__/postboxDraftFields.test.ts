/**
 * One draft-field snapshot for autosave and the offline send payload, and the
 * device mirror reading the same message (issue #864, finding 14).
 *
 * Autosave and the offline payload write `composeDraftFields` itself. The
 * mirror records every field in every mode (blocks included, so a simple-mode
 * copy can be compared like for like), and what matters is that the row a save
 * leaves behind reads back EQUAL to the mirror's copy: otherwise every saved
 * composition would be offered back as "unsaved changes" on the next open.
 * The cases below run the real composables on one set of refs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { composeDraftFields, type DraftComposerMode } from '../postboxDraftFields';
import { PostboxDraftMirrorStore } from '../postboxDraftMirrorStore';
import type * as DraftMirrorStoreModule from '../postboxDraftMirrorStore';
import {
	canonicalBlocks,
	mirrorFieldsEqual,
	mirrorFieldsOfRow,
	type MirrorCopy,
} from '../postboxDraftMirror';
import type { OfflineComposePayload, OfflineKvDriver } from '../postboxOfflineStore';
import { usePostboxComposeAutosave } from '~/composables/postbox/usePostboxComposeAutosave';
import {
	DRAFT_MIRROR_DEBOUNCE_MS,
	usePostboxComposeMirror,
} from '~/composables/postbox/usePostboxComposeMirror';
import { usePostboxComposeOfflineSend } from '~/composables/postbox/usePostboxComposeOfflineSend';
import { usePostboxComposeTouched } from '~/composables/postbox/usePostboxComposeTouched';
import type { LatestDraftRow } from '~/composables/postbox/usePostboxComposeHydration';

const BLOCKS = [{ id: 'b1', type: 'text', content: 'Hi' }] as unknown as EditorBlock[];

function fieldRefs(mode: DraftComposerMode) {
	return {
		toAddresses: ref(['ada@example.com']),
		ccAddresses: ref(['bob@example.com']),
		bccAddresses: ref<string[]>([]),
		subject: ref('Quarterly numbers'),
		bodyHtml: ref('<p>Here they are.</p>'),
		bodyBlocks: ref<EditorBlock[]>(BLOCKS),
		composerMode: ref<DraftComposerMode>(mode),
	};
}

describe('composeDraftFields', () => {
	it('serialises bodyBlocks only in full mode', () => {
		expect(composeDraftFields(fieldRefs('full')).bodyBlocks).toBe(JSON.stringify(BLOCKS));
		const simple = composeDraftFields(fieldRefs('simple'));
		expect(simple.bodyBlocks).toBeUndefined();
		expect(simple.composerMode).toBe('simple');
	});

	it('copies the recipient lists, so a later edit cannot reach the snapshot', () => {
		const refs = fieldRefs('simple');
		const snapshot = composeDraftFields(refs);
		refs.toAddresses.value.push('late@example.com');
		expect(snapshot.toAddresses).toEqual(['ada@example.com']);
	});
});

/** In-memory stand-in for IndexedDB. */
function memoryDriver(): OfflineKvDriver {
	const map = new Map<string, unknown>();
	return {
		persistent: true,
		async get<T>(key: string) {
			return map.get(key) as T | undefined;
		},
		async set(key, value) {
			map.set(key, JSON.parse(JSON.stringify(value)));
		},
		async delete(key) {
			map.delete(key);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
}

let store: PostboxDraftMirrorStore;
vi.mock('~/utils/postboxDraftMirrorStore', async (importActual) => {
	const actual = await importActual<typeof DraftMirrorStoreModule>();
	return { ...actual, getPostboxDraftMirrorStore: () => store };
});

describe('autosave and offline payload share one snapshot; the mirror reads it back equal', () => {
	let driver: OfflineKvDriver;
	let scope: EffectScope;

	beforeEach(() => {
		vi.useFakeTimers();
		driver = memoryDriver();
		store = new PostboxDraftMirrorStore(driver);
		scope = effectScope();
	});

	afterEach(() => {
		scope.stop();
		vi.useRealTimers();
	});

	async function captureAll(mode: DraftComposerMode) {
		const refs = fieldRefs(mode);
		const followUpRemindAt = ref<number | null>(1_700_000_000_000);
		const draftId = ref<string | null>('draft-1');
		const updateRun = vi.fn(async (_args: Record<string, unknown>) => ({
			ok: true as const,
			result: { savedAt: 1 },
		}));
		const queue = vi.fn(async (_payload: OfflineComposePayload) => ({
			undoToken: 'outbox:1',
			sendAt: 0,
		}));

		const { autosave, queueOffline } = scope.run(() => {
			const common = { mailboxId: 'mbx-1' as never, draftId: draftId as never, ...refs };
			const touched = usePostboxComposeTouched({ ...refs, followUpRemindAt }, []);
			const autosave = usePostboxComposeAutosave({
				...common,
				draftState: ref('draft'),
				initialHydration: ref('ready'),
				ensuring: ref(false),
				isSaving: ref(false),
				lastSavedAt: ref(null),
				touched,
				onReopenExisting: () => {},
				onGone: () => {},
				followUpRemindAt,
				createDraft: { run: vi.fn() } as never,
				updateDraft: { run: updateRun } as never,
			});
			usePostboxComposeMirror({
				...common,
				ready: ref(true),
				draftState: ref('draft'),
				// The row is not observed in this test, so the copy is kept.
				latestRow: ref<LatestDraftRow>({ status: 'unknown' }),
				touched,
				followUpRemindAt,
				autosave,
			});
			const queueOffline = usePostboxComposeOfflineSend({
				...common,
				fromAddress: ref('me@example.com'),
				followUpRemindAt,
				attachments: ref([]),
				cancelAutosave: () => {},
				queue,
				undoSendDelayMs: () => undefined,
			});
			return { autosave, queueOffline };
		})!;

		// One edit wakes both debounced writers.
		refs.subject.value = 'Quarterly numbers (final)';
		await nextTick();
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		await autosave.flush();
		await queueOffline();

		const key = (await driver.keys()).find((k) => k.endsWith(':live'))!;
		const mirrored = await driver.get<MirrorCopy>(key);
		return {
			saved: updateRun.mock.calls.at(-1)![0],
			mirrored: mirrored!.fields,
			queued: queue.mock.calls[0]![0],
		};
	}

	it.each(['simple', 'full'] as const)('in %s mode', async (mode) => {
		const { saved, mirrored, queued } = await captureAll(mode);

		// The row the save leaves behind (a simple-mode save keeps the stored
		// blocks, which are the composer's) reads back equal to the mirror.
		const row = mirrorFieldsOfRow({
			...(saved as Record<string, never>),
			bodyBlocks: (saved['bodyBlocks'] as string | undefined) ?? JSON.stringify(BLOCKS),
		});
		expect(mirrorFieldsEqual(mirrored, row)).toBe(true);
		expect(mirrored.subject).toBe('Quarterly numbers (final)');
		expect(mirrored.bodyBlocks).toBe(canonicalBlocks(BLOCKS));

		// The reminder too: a reminder set just before a failed save is as much
		// unsaved work as the text.
		expect(saved['followUpRemindAt']).toBe(1_700_000_000_000);
		expect(mirrored.followUpRemindAt).toBe(1_700_000_000_000);

		// The offline payload carries autosave's snapshot plus its replay extras.
		const { draftId: _id, ...wire } = saved;
		expect(queued).toMatchObject(wire);
		expect(queued).toMatchObject({
			mailboxId: 'mbx-1',
			draftId: 'draft-1',
			fromAddress: 'me@example.com',
			followUpRemindAt: 1_700_000_000_000,
			attachments: [],
		});
	});
});
