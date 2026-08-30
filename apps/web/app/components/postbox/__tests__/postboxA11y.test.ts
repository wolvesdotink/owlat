// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ACROSS THE FOUR SURFACES POSTBOX IS MADE OF.
 *
 * Mail is the one screen in this app a person lives in all day, and it is the
 * one built almost entirely out of custom controls: a contenteditable body, a
 * combobox search bar, a virtualized list of `<li>` rows that behave like a
 * grid, and a reader whose chrome is two dozen icon-only buttons. None of that
 * gets an accessible name for free the way a `<button>Send</button>` does, so
 * the four surfaces are audited here with axe against the REAL message catalog
 * (see `~/__tests__/a11y` for what the harness does and does not cover).
 *
 * Two label defects are what motivated the suite and are pinned as their own
 * regression cases at the bottom: the composer body (`role="textbox"` on a
 * contenteditable div, which nothing can label implicitly) and the search bar
 * (`role="combobox"` whose only "label" was a placeholder).
 *
 * The child feature components are left unresolved on purpose — that is the
 * harness's deal, and each carries its own suite. What is audited here is each
 * surface's OWN chrome: headings, toolbars, empty states, the row semantics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, useId, type Ref } from 'vue';
import {
	auditA11y,
	dashboardShellStubs,
	installNuxtStubs,
	paginatedResult,
} from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useCommandPaletteRecents } from '~/composables/useCommandPaletteRecents';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useDropZone } from '~/composables/useDropZone';
import { useLocalStorage } from '~/composables/useLocalStorage';
import { useRichText } from '@owlat/ui/composables/useRichText';

import PostboxLayout from '../PostboxLayout.vue';
import PostboxThreadList from '../PostboxThreadList.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxThreadReader, { type PostboxReaderMessage } from '../PostboxThreadReader.vue';
import PostboxComposer from '../PostboxComposer.vue';
import PostboxComposerEnvelope from '../PostboxComposerEnvelope.vue';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';
import PostboxComposerHeader from '../PostboxComposerHeader.vue';
import PostboxSearchBar from '../PostboxSearchBar.vue';
import PostboxBasicEditor from '../PostboxBasicEditor.vue';

// The generated Convex `api` object only ever reaches the stubbed query and
// operation composables here, so a self-returning proxy stands in for any path
// — importing the real one drags the whole generated module graph into a UI
// audit for nothing.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** One arrived message, complete enough that every row/reader branch renders. */
function readerMessage(overrides: Partial<PostboxReaderMessage> = {}): PostboxReaderMessage {
	return {
		_id: 'msg1',
		mailboxId: 'mbx1',
		threadId: 'thread1',
		fromAddress: 'ines@example.com',
		fromName: 'Ines Weber',
		toAddresses: ['ada@example.com'],
		ccAddresses: [],
		subject: 'Quarterly numbers',
		snippet: 'Here are the numbers you asked for.',
		receivedAt: Date.UTC(2026, 0, 14, 9, 30),
		textBodyInline: 'Here are the numbers you asked for.',
		hasAttachments: false,
		attachments: [],
		...overrides,
	};
}

function rowMessage(overrides: Partial<PostboxThreadRowMessage> = {}): PostboxThreadRowMessage {
	return {
		_id: 'msg1' as PostboxThreadRowMessage['_id'],
		threadId: 'thread1',
		fromAddress: 'ines@example.com',
		fromName: 'Ines Weber',
		subject: 'Quarterly numbers',
		snippet: 'Here are the numbers you asked for.',
		receivedAt: Date.UTC(2026, 0, 14, 9, 30),
		flagSeen: false,
		flagFlagged: false,
		hasAttachments: true,
		...overrides,
	};
}

/**
 * Every function export under `app/composables/postbox/` and `app/utils/`,
 * keyed by its name — the two directories Nuxt auto-imports Postbox's own
 * composables and pure helpers from. Taking whole directories (rather than a
 * hand-written stub per name) keeps the audited markup the markup the app
 * paints, and stops this file going quietly stale when a surface reaches for
 * one more helper: today a missing one is a `ReferenceError`, not a silent pass.
 */
function autoImportedHelpers(): Record<string, unknown> {
	const modules = {
		...import.meta.glob('../../../composables/postbox/*.ts', { eager: true }),
		...import.meta.glob('../../../utils/postbox*.ts', { eager: true }),
	};
	const helpers: Record<string, unknown> = {};
	for (const module of Object.values(modules)) {
		for (const [name, value] of Object.entries(module as Record<string, unknown>)) {
			if (typeof value === 'function') helpers[name] = value;
		}
	}
	return helpers;
}

/**
 * The Postbox composables every audited surface destructures at setup. Inert
 * on purpose: what is under audit is the markup each surface paints, not the
 * behaviour of the feeds behind it (those carry their own suites). Anything a
 * template BRANCHES on is given the value that renders the most markup, so the
 * audit sees the widest surface rather than a spinner.
 */
function postboxStubs(rows: PostboxThreadRowMessage[]): Record<string, unknown> {
	return {
		// Postbox's own composables and pure helpers, at their REAL
		// implementations. The backend-shaped few are overridden below.
		...autoImportedHelpers(),

		// Shared composables the audited surfaces reach for. Pure ones run for
		// real; the harness's own defaults cover the rest.
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useDebouncedSearch,
		// The search bar reads the one scope-tagged palette history (Mail tag);
		// it is localStorage-only, so the real one runs here.
		useCommandPaletteRecents,
		useDropZone,
		useLocalStorage,
		useRichText,
		usePaginatedQuery: () => paginatedResult([]),
		// The list parks the pending-compose intent in `useState` under this
		// auto-imported key constant.
		POSTBOX_PENDING_COMPOSE_KEY: 'postbox:pending-compose',
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		// Postbox registers itself as the command palette's current surface on
		// mount; the registry is app-wide state no audit needs.
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),

		// Feed-shaped overrides: the real ones subscribe to Convex, which the
		// harness answers `undefined` for, and an audit of a permanently empty list
		// is an audit of a skeleton. Rows are handed in instead so the list, the
		// row semantics and the reader all render loaded.
		usePostboxThreads: () => ({
			messages: ref(rows),
			isLoading: ref(false),
			isLoadingMore: ref(false),
			isRefetching: ref(false),
			hasMore: ref(false),
			canLoadMore: ref(false),
			loadMore: vi.fn(),
		}),
		usePostboxOfflineThreads: () => ({
			rows: ref(rows),
			showingCached: ref(false),
			isOffline: ref(false),
			cachedAt: ref(null),
		}),
		usePostboxOptimisticHide: (messages: Ref<unknown[]>) => ({
			visible: computed(() => messages.value),
			hide: vi.fn(),
			unhide: vi.fn(),
		}),
	};
}

const ROWS = [
	rowMessage(),
	rowMessage({ _id: 'msg2' as PostboxThreadRowMessage['_id'], flagSeen: true }),
];

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...postboxStubs(ROWS),
		useRoute: () => ({
			path: '/dashboard/postbox/inbox',
			fullPath: '/dashboard/postbox/inbox',
			name: 'postbox',
			params: { folder: 'inbox' },
			query: {},
			hash: '',
			meta: {},
		}),
	});
});

/**
 * Mount options every audit here shares: the real catalog, plus the pure
 * helpers a TEMPLATE calls by bare name. Those compile to `_ctx.helper`, which
 * no global can answer — `mocks` is the only seam for them.
 */
function withCatalog(components: Record<string, unknown> = {}) {
	return {
		global: { plugins: [createTestI18n()], mocks: autoImportedHelpers(), components },
	};
}

/**
 * The two rules the thread row cannot satisfy while it stays a `listbox` of
 * composite rows: each row's link is an `option` that CONTAINS the select
 * checkbox (`nested-interactive`), and the hover quick-actions sit beside the
 * link as further children the listbox would own (`aria-required-children`).
 * Both need the row to become a `grid` row (or the per-row controls to move out
 * of the option) — a keyboard-model change, deferred rather than papered over.
 */
const KNOWN_COMPOSITE_ROW_GAPS = ['nested-interactive', 'aria-required-children'];

describe('postbox thread list — accessibility', () => {
	// The rows are the point of the list audit — `listbox`/`option` semantics,
	// the `<li>` parenting and the row's icon-only affordances all live there —
	// so the row components are registered rather than left unresolved.
	const rowComponents = { PostboxThreadRow, PostboxRowCore, PostboxEmptyState };

	it('has no axe violations with rows', async () => {
		const violations = await auditA11y(PostboxThreadList, {
			...withCatalog(rowComponents),
			props: { mailboxId: 'mbx1', messages: ROWS, loading: false, folderRole: 'inbox' },
			// A list that rendered zero rows would sail through every rule here.
			prepare: (wrapper) => {
				expect(wrapper.findAll('[role="option"]').length).toBe(ROWS.length);
			},
		});
		// Everything except the two composite-row gaps, which are a listbox
		// keyboard-model question rather than a missing attribute — see
		// docs/ux-plan/DEFERRALS.md. Pinned by COUNT as well as by rule, so
		// closing them fails here and forces this expectation to be retired
		// rather than quietly widening the exemption.
		expect(
			violations.filter((v) => !KNOWN_COMPOSITE_ROW_GAPS.some((r) => v.startsWith(r)))
		).toEqual([]);
		expect(violations).toHaveLength(1 + ROWS.length);
	});

	it('has no axe violations on an empty folder', async () => {
		const violations = await auditA11y(PostboxThreadList, {
			...withCatalog(rowComponents),
			props: { mailboxId: 'mbx1', messages: [], loading: false, folderRole: 'inbox' },
			prepare: (wrapper) => expect(wrapper.text()).not.toBe(''),
		});
		expect(violations).toEqual([]);
	});
});

describe('postbox reader — accessibility', () => {
	it('has no axe violations on an arrived message', async () => {
		const violations = await auditA11y(PostboxThreadReader, {
			// The overflow menu is registered rather than left unresolved: it is
			// where most of the reader's verbs live, and its trigger is icon-only.
			...withCatalog({ PostboxOverflowMenu }),
			props: { message: readerMessage(), folderRole: 'inbox' },
			prepare: (wrapper) => expect(wrapper.text()).toContain('Ines Weber'),
		});
		expect(violations).toEqual([]);
	});
});

describe('postbox composer — accessibility', () => {
	it('has no axe violations on a blank draft', async () => {
		const violations = await auditA11y(PostboxComposer, {
			// The composer's own template is a wrapper; every control a person
			// touches lives in the header, the envelope, the body and the footer,
			// so those four are registered rather than left unresolved.
			...withCatalog({
				PostboxComposerHeader,
				PostboxComposerEnvelope,
				PostboxBasicEditor,
				PostboxComposerFooter,
				PostboxOverflowMenu,
			}),
			props: { mailboxId: 'mbx1' },
			prepare: (wrapper) => expect(wrapper.find('[role="textbox"]').exists()).toBe(true),
		});
		expect(violations).toEqual([]);
	});
});

describe('postbox layout — accessibility', () => {
	it('has no axe violations on the inbox', async () => {
		const violations = await auditA11y(PostboxLayout, {
			...withCatalog(),
			props: { mailboxId: 'mbx1', folderRole: 'inbox' },
		});
		expect(violations).toEqual([]);
	});
});

/**
 * THE TWO LABEL DEFECTS THIS SUITE WAS WRITTEN FOR.
 *
 * Both are custom-role controls, so no native labelling mechanism applies and
 * both shipped nameless. Pinned as their own cases (not just folded into the
 * surface audits above) because the fix is a single attribute a refactor can
 * drop without any other test noticing.
 */
describe('custom-role controls carry an accessible name', () => {
	it('names the contenteditable composer body', async () => {
		const violations = await auditA11y(PostboxBasicEditor, {
			...withCatalog(),
			props: { modelValue: '' },
			prepare: (wrapper) => {
				const box = wrapper.get('[role="textbox"]');
				expect(box.attributes('aria-label')).toBe('Message body');
			},
		});
		expect(violations).toEqual([]);
	});

	it('takes a caller-supplied placeholder as the body name when there is one', async () => {
		await auditA11y(PostboxBasicEditor, {
			...withCatalog(),
			props: { modelValue: '', placeholder: 'Your signature…' },
			prepare: (wrapper) => {
				expect(wrapper.get('[role="textbox"]').attributes('aria-label')).toBe('Your signature…');
				// The overlay repeats the accessible name, so it must not be
				// announced a second time as content.
				expect(wrapper.get('.absolute.top-3').attributes('aria-hidden')).toBe('true');
			},
		});
	});

	it('names the search combobox with a label rather than its placeholder', async () => {
		const violations = await auditA11y(PostboxSearchBar, {
			...withCatalog(),
			props: { modelValue: '' },
			prepare: (wrapper) => {
				const box = wrapper.get('[role="combobox"]');
				expect(box.attributes('aria-label')).toBe('Search mail');
			},
		});
		expect(violations).toEqual([]);
	});
});
