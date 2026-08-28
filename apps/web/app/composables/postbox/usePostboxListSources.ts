/**
 * The data behind each inbox list renderer, in one place.
 *
 * PostboxLayout owns the panes; which feed a renderer reads is a separate
 * concern that was accreting in that file one view mode at a time (thread
 * groups, then categories, then bundles), each with its own `enabled` flag,
 * its own destructure and its own rename. Lifting all three out keeps the
 * layout under the file-size cap and puts the one invariant they share in a
 * single place: EXACTLY ONE renderer is active, so exactly one of these feeds
 * subscribes at a time — the others pass `'skip'` and cost nothing.
 *
 * The bundled feed is the odd one out and deliberately so: it takes the flat
 * list's rows (already fetched, already filtered by the triage chips) and folds
 * them client-side, so it adds no message query — only the thread-category join
 * the fold needs.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import type { PostboxThreadRowMessage } from '~/components/postbox/PostboxThreadRow.vue';

export function usePostboxListSources(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	/** Which renderer the active view mode resolved to for this folder. */
	renderer: Ref<PostboxViewMode>;
	/** The flat list's rows — what the bundled view folds. */
	listMessages: Ref<PostboxThreadRowMessage[]>;
}) {
	const conversationsEnabled = computed(() => args.renderer.value === 'conversations');
	const categoriesEnabled = computed(() => args.renderer.value === 'categories');
	const bundlesEnabled = computed(() => args.renderer.value === 'bundled');
	/** True for every renderer that is not the plain flat list. */
	const grouped = computed(() => args.renderer.value !== 'flat');

	const conversations = usePostboxThreadGroups({
		mailboxId: args.mailboxId,
		folderRole: args.folderRole,
		enabled: conversationsEnabled,
	});

	// Smart-inbox split view — groups the inbox into People / Newsletters /
	// Notifications / Receipts sections.
	const categories = usePostboxThreadCategories({
		mailboxId: args.mailboxId,
		folderRole: args.folderRole,
		enabled: categoriesEnabled,
	});

	// Bundled view — the flat feed with runs of consecutive low-signal mail
	// folded into one expandable row per category.
	const bundles = usePostboxThreadBundles({
		mailboxId: args.mailboxId,
		messages: args.listMessages,
		enabled: bundlesEnabled,
	});

	return {
		conversationsEnabled,
		categoriesEnabled,
		bundlesEnabled,
		grouped,
		conversations,
		categories,
		bundles,
	};
}
