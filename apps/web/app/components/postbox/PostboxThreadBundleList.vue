<script setup lang="ts">
/**
 * Bundled view — the flat feed with runs of consecutive low-signal mail folded
 * into one expandable row per category ("Newsletters · 12 · latest from
 * Northwind Digest"), each carrying an archive-all and, where the senders
 * support RFC 8058 one-click, an unsubscribe-all.
 *
 * Deliberately NOT windowed, unlike the flat and grouped renderers: folding is
 * what keeps this list short — a page of fifty messages with forty newsletters
 * in it renders as a dozen rows — so windowing would be machinery paid for
 * with nothing to show for it. The fold itself is pure (utils/postboxBundles)
 * and the two verbs live in usePostboxThreadBundles; this component is the
 * markup and the disclosure.
 */
import type { Id } from '@owlat/api/dataModel';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import {
	POSTBOX_BUNDLE_META,
	bundleMessageIds,
	bundleOneClickSenders,
	type PostboxFeedEntry,
} from '~/utils/postboxBundles';

const props = defineProps<{
	entries: Array<PostboxFeedEntry<PostboxThreadRowMessage>>;
	expanded: Record<string, boolean>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	/** A further page exists AND there is a cursor to walk to it. */
	hasMore?: boolean;
	/** An action is in flight — the per-bundle verbs stay disabled meanwhile. */
	busy?: boolean;
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'toggle', bundleId: string): void;
	(e: 'archive-bundle', messageIds: string[]): void;
	(e: 'unsubscribe-bundle', senderEmails: string[], messageIds: string[]): void;
}>();

const { t } = useI18n();

function messageTo(message: { _id: Id<'mailMessages'> }) {
	return `/dashboard/postbox/${props.folderRole}/${String(message._id)}`;
}

/** Every message this list renders, bundles expanded, for j/k navigation. */
const navigableMessages = computed(() =>
	props.entries.flatMap((entry) =>
		entry.kind === 'bundle'
			? props.expanded[entry.id]
				? entry.messages
				: []
			: [entry.message]
	)
);

const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
	items: navigableMessages,
	resetKey: computed(() => props.folderRole),
	rowDomId: (message) => `postbox-bundled-${String(message._id)}`,
	onActivate: (message) => void navigateTo(messageTo(message)),
});

/** Flat index of a message among the navigable ones, for the focus ring. */
function focusIndexOf(messageId: string): number {
	return navigableMessages.value.findIndex((message) => String(message._id) === messageId);
}

function senderOf(message: PostboxThreadRowMessage): string {
	return message.fromName?.trim() || message.fromAddress;
}
</script>

<template>
	<div class="h-full overflow-auto">
		<PostboxThreadListSkeleton v-if="loading && entries.length === 0" />
		<PostboxEmptyState
			v-else-if="entries.length === 0"
			icon="lucide:check-circle-2"
			:title="t('components.postbox.postboxThreadBundleList.allClear')"
		/>
		<ul
			v-else
			tabindex="0"
			role="listbox"
			:aria-label="t('components.postbox.postboxThreadBundleList.listLabel')"
			:aria-activedescendant="activeId"
			class="divide-y divide-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			@keydown="onKeydown"
		>
			<template v-for="entry in entries">
				<!-- A plain row: everything the fold left alone. -->
				<li v-if="entry.kind === 'message'" :key="String(entry.message._id)">
					<NuxtLink
						:id="`postbox-bundled-${String(entry.message._id)}`"
						role="option"
						:aria-selected="focusedIndex === focusIndexOf(String(entry.message._id))"
						:to="messageTo(entry.message)"
						class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
						:class="{ 'bg-bg-elevated': activeMessageId === String(entry.message._id) }"
					>
						<div class="flex items-baseline justify-between gap-3">
							<span
								class="truncate text-sm"
								:class="
									entry.message.flagSeen
										? 'text-text-secondary'
										: 'font-semibold text-text-primary'
								"
							>
								{{ senderOf(entry.message) }}
							</span>
							<span class="text-xs text-text-tertiary flex-shrink-0">
								{{ formatThreadTimestamp(entry.message.receivedAt) }}
							</span>
						</div>
						<p
							class="truncate text-sm mt-0.5"
							:class="entry.message.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
						>
							{{
								entry.message.subject || t('components.postbox.postboxThreadBundleList.noSubject')
							}}
						</p>
						<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
							{{ entry.message.snippet }}
						</p>
					</NuxtLink>
				</li>

				<!-- A bundle: one row standing for a run, with its own two verbs. -->
				<li v-else :key="entry.id" class="bg-bg-surface">
					<div class="flex items-center gap-2 px-4 py-3">
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-2 text-left outline-none rounded focus-visible:ring-1 focus-visible:ring-brand/50"
							:aria-expanded="expanded[entry.id] === true"
							@click="emit('toggle', entry.id)"
						>
							<Icon
								:name="expanded[entry.id] ? 'lucide:chevron-down' : 'lucide:chevron-right'"
								class="w-4 h-4 flex-shrink-0 text-text-tertiary"
							/>
							<Icon
								:name="POSTBOX_BUNDLE_META[entry.category].icon"
								class="w-4 h-4 flex-shrink-0 text-text-tertiary"
							/>
							<span class="truncate text-sm font-medium text-text-primary">
								<!-- Always plural: a bundle is never fewer than two rows. -->
								{{ t(POSTBOX_BUNDLE_META[entry.category].label) }}
							</span>
							<span class="text-xs text-text-tertiary tabular-nums flex-shrink-0">
								{{ entry.count }}
							</span>
							<span
								v-if="entry.unreadCount > 0"
								class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center flex-shrink-0"
							>
								{{ entry.unreadCount }}
							</span>
							<span class="truncate text-xs text-text-tertiary">
								{{
									t('components.postbox.postboxThreadBundleList.latestFrom', {
										sender: entry.latestFrom,
									})
								}}
							</span>
						</button>

						<!-- Unsubscribe only where a batch can actually perform it: a
						     sender with a plain web page needs a human on that page, and
						     offering it here would be a promise this row cannot keep. -->
						<button
							v-if="bundleOneClickSenders(entry.messages).length > 0"
							type="button"
							class="flex-shrink-0 rounded px-2 py-1 text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-elevated outline-none focus-visible:ring-1 focus-visible:ring-brand/50 disabled:opacity-50"
							:disabled="busy"
							:title="t('components.postbox.postboxThreadBundleList.unsubscribeHint')"
							@click="
								emit(
									'unsubscribe-bundle',
									bundleOneClickSenders(entry.messages),
									bundleMessageIds(entry.messages)
								)
							"
						>
							{{ t('components.postbox.postboxThreadBundleList.unsubscribe') }}
						</button>
						<button
							type="button"
							class="flex-shrink-0 rounded px-2 py-1 text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-elevated outline-none focus-visible:ring-1 focus-visible:ring-brand/50 disabled:opacity-50"
							:disabled="busy"
							:aria-label="
								t('components.postbox.postboxThreadBundleList.archiveAllLabel', {
									count: entry.count,
								})
							"
							@click="emit('archive-bundle', bundleMessageIds(entry.messages))"
						>
							{{ t('components.postbox.postboxThreadBundleList.archiveAll') }}
						</button>
					</div>

					<!-- The rows themselves, one disclosure away. Nothing is hidden:
					     the bundle states its own count and every message is here. -->
					<ul v-if="expanded[entry.id]" class="border-t border-border-subtle bg-bg-base">
						<li v-for="message in entry.messages" :key="String(message._id)">
							<NuxtLink
								:id="`postbox-bundled-${String(message._id)}`"
								role="option"
								:aria-selected="focusedIndex === focusIndexOf(String(message._id))"
								:to="messageTo(message)"
								class="pbx-row-link block pl-10 pr-4 py-2 hover:bg-bg-elevated"
								:class="{ 'bg-bg-elevated': activeMessageId === String(message._id) }"
							>
								<div class="flex items-baseline justify-between gap-3">
									<span
										class="truncate text-sm"
										:class="
											message.flagSeen ? 'text-text-secondary' : 'font-semibold text-text-primary'
										"
									>
										{{ senderOf(message) }}
									</span>
									<span class="text-xs text-text-tertiary flex-shrink-0">
										{{ formatThreadTimestamp(message.receivedAt) }}
									</span>
								</div>
								<p class="truncate text-sm text-text-secondary mt-0.5">
									{{
										message.subject || t('components.postbox.postboxThreadBundleList.noSubject')
									}}
								</p>
							</NuxtLink>
						</li>
					</ul>
				</li>
			</template>
		</ul>

		<div v-if="hasMore" class="p-4 text-center">
			<UiButton variant="secondary" size="sm" @click="emit('load-more')">
				{{ t('components.postbox.postboxThreadBundleList.loadMore') }}
			</UiButton>
		</div>
	</div>
</template>
