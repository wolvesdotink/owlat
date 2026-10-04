/**
 * One draft-field snapshot for autosave, the on-device mirror and the offline
 * send payload (issue #864, finding 14).
 *
 * The mirror's restore offer compares its stored snapshot with the server row,
 * so the three copies of these fields used to have to agree by comment. The
 * cases below run the real composables on one set of refs and check that what
 * each of them writes is the same snapshot, not three that happen to match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { composeDraftFields, type DraftComposerMode } from '../postboxDraftFields';
import { PostboxDraftMirrorStore } from '../postboxDraftMirrorStore';
import type * as DraftMirrorStoreModule from '../postboxDraftMirrorStore';
import type { DraftMirrorEntry } from '../postboxDraftMirror';
import type { OfflineComposePayload, OfflineKvDriver } from '../postboxOfflineStore';
import { usePostboxComposeAutosave } from '~/composables/postbox/usePostboxComposeAutosave';
import {
	DRAFT_MIRROR_DEBOUNCE_MS,
	usePostboxComposeMirror,
} from '~/composables/postbox/usePostboxComposeMirror';
import { usePostboxComposeOfflineSend } from '~/composables/postbox/usePostboxComposeOfflineSend';

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

describe('autosave, mirror and offline payload share one snapshot', () => {
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
			const autosave = usePostboxComposeAutosave({
				...common,
				draftState: ref('draft'),
				initialHydration: ref('ready'),
				ensuring: ref(false),
				isSaving: ref(false),
				// Kept null so the mirror's "server caught up" clear does not run
				// before the test reads the entry back.
				lastSavedAt: ref(null),
				rowCreatedAt: ref(null),
				followUpRemindAt,
				createDraft: { run: vi.fn() } as never,
				updateDraft: { run: updateRun } as never,
			});
			usePostboxComposeMirror({
				...common,
				seedDraftId: 'draft-1' as never,
				// The loaded row: the mirror reconciles once, then mirrors. Its own
				// ref, so autosave's save does not read as "server caught up".
				lastSavedAt: ref(100),
				ready: () => true,
				followUpRemindAt,
				draftState: ref('draft'),
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

		// The mirror's reconcile reads the store first; it writes only after.
		await vi.advanceTimersByTimeAsync(0);
		// One edit wakes both debounced writers.
		refs.subject.value = 'Quarterly numbers (final)';
		await nextTick();
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		await autosave.flush();
		await queueOffline();

		const mirrored = await driver.get<DraftMirrorEntry>('draft-mirror:mbx-1:draft-1');
		return {
			saved: updateRun.mock.calls.at(-1)![0],
			mirrored: mirrored!.fields,
			queued: queue.mock.calls[0]![0],
		};
	}

	it.each(['simple', 'full'] as const)('in %s mode', async (mode) => {
		const { saved, mirrored, queued } = await captureAll(mode);

		// The mirror stores exactly the autosave args on every key it has.
		const shared = Object.fromEntries(Object.keys(mirrored).map((key) => [key, saved[key]]));
		expect(mirrored).toEqual(shared);
		expect(mirrored.subject).toBe('Quarterly numbers (final)');

		// The reminder too: a reminder set just before a failed save is as much
		// unsaved work as the text.
		expect(saved['followUpRemindAt']).toBe(1_700_000_000_000);
		expect(mirrored.followUpRemindAt).toBe(1_700_000_000_000);

		// The offline payload carries the same snapshot plus its replay extras.
		expect(queued).toMatchObject(mirrored);
		expect(queued).toMatchObject({
			mailboxId: 'mbx-1',
			draftId: 'draft-1',
			fromAddress: 'me@example.com',
			followUpRemindAt: 1_700_000_000_000,
			attachments: [],
		});
	});
});
