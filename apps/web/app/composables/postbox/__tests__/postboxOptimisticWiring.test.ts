/**
 * The Postbox's list, bulk and label writes carry their native Convex
 * optimistic update (plan 2.2), so the local store repaints before the server
 * answers. The updaters themselves are tested against a fake local store in
 * `lib/mailOptimistic/__tests__`; this pins which write sends which one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import * as mailUpdaters from '~/lib/mailOptimistic/mailUpdaters';
import * as labelUpdaters from '~/lib/mailOptimistic/labelUpdaters';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** Each operation's options, by its (echoed) label key, in creation order. */
let options: Record<string, Array<{ optimisticUpdate?: unknown }>>;

const updaterOf = (label: string, index = 0) => options[label]?.[index]?.optimisticUpdate;

beforeEach(() => {
	options = {};
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack: vi.fn() }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), isLoading: ref(false) }));
	vi.stubGlobal(
		'useBackendOperation',
		(_fn: unknown, opts: { label: () => string; optimisticUpdate?: unknown }) => {
			(options[opts.label()] ??= []).push(opts);
			return { run: vi.fn(), isLoading: ref(false), inlineError: ref(null) };
		}
	);
});

describe('Postbox writes send their optimistic update', () => {
	it('bulk actions: read/star, archive, trash and move', async () => {
		const { usePostboxBulkActions } = await import('../usePostboxBulkActions');
		usePostboxBulkActions(ref('mb' as never));
		const bulk = 'shared.postbox.usePostboxBulkActions.';
		expect(updaterOf(`${bulk}setFlagsOperation`)).toBe(mailUpdaters.optimisticSetFlags);
		expect(updaterOf(`${bulk}archiveOperation`)).toBe(mailUpdaters.optimisticArchive);
		expect(updaterOf(`${bulk}trashOperation`)).toBe(mailUpdaters.optimisticTrash);
		expect(updaterOf(`${bulk}moveOperation`)).toBe(mailUpdaters.optimisticMove);
	});

	it('list row verbs, including the drag onto a folder', async () => {
		const { usePostboxRowTriage } = await import('../usePostboxRowTriage');
		usePostboxRowTriage({ hide: vi.fn(), unhide: vi.fn(), setFlags: vi.fn(), clearFlags: vi.fn() });
		const list = 'components.postbox.postboxThreadList.';
		expect(updaterOf(`${list}archiveOperation`)).toBe(mailUpdaters.optimisticArchive);
		expect(updaterOf(`${list}trashOperation`)).toBe(mailUpdaters.optimisticTrash);
		expect(updaterOf(`${list}starOperation`)).toBe(mailUpdaters.optimisticSetStar);
		expect(updaterOf(`${list}markReadOperation`)).toBe(mailUpdaters.optimisticMarkRead);
		expect(updaterOf(`${list}snoozeOperation`, 0)).toBe(mailUpdaters.optimisticSnooze);
		expect(updaterOf(`${list}snoozeOperation`, 1)).toBe(mailUpdaters.optimisticSnoozeThread);
		expect(updaterOf(`${list}moveOperation`)).toBe(mailUpdaters.optimisticMove);
	});

	it('label edits and label-on-mail writes', async () => {
		const { usePostboxLabels } = await import('../usePostboxLabels');
		usePostboxLabels(ref('mb' as never));
		const labels = 'shared.postbox.usePostboxLabels.';
		expect(updaterOf(`${labels}updateLabel`)).toBe(labelUpdaters.optimisticUpdateLabel);
		expect(updaterOf(`${labels}reorderLabels`)).toBe(labelUpdaters.optimisticReorderLabels);
		expect(updaterOf(`${labels}updateMessageLabels`, 0)).toBe(
			mailUpdaters.optimisticToggleLabelOnMessage
		);
		expect(updaterOf(`${labels}updateMessageLabels`, 1)).toBe(
			mailUpdaters.optimisticSetLabelOnMessages
		);
		expect(updaterOf(`${labels}updateThreadLabels`)).toBe(
			mailUpdaters.optimisticToggleLabelOnThread
		);
		// Creating and deleting a label keep the plain round trip.
		expect(updaterOf(`${labels}createLabel`)).toBeUndefined();
		expect(updaterOf(`${labels}deleteLabel`)).toBeUndefined();
	});
});
