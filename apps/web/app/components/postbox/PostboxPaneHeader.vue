<script setup lang="ts">
/**
 * The top of the conversation pane: which mailbox this is (its menu switches
 * mailboxes and holds what the folder rail used to: Sent, Archive, every
 * folder, the traditional layout), New, a greeting that names who may need a
 * reply, the People · Updates · Drafts tabs and the search field.
 *
 * The greeting only speaks when someone is waiting: at most two names, each a
 * link to that person's conversations that may need a reply.
 */
import type { Id } from '@owlat/api/dataModel';
import {
	ArchiveIcon,
	ChevronDownIcon,
	FoldersIcon,
	ColumnsIcon,
	MailIcon,
	PaperPlaneIcon,
	SearchIcon,
	UsersIcon,
} from '@coolicons/vue';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	mailboxAddress: string | null;
	view: 'people' | 'updates';
	updatesUnread: number;
	/** Who may need a reply, most recent first, each with the link to their open asks. */
	waiting: ReadonlyArray<{ key: string; name: string; href: string }>;
	/** Prefills New with whoever is open. */
	newTo: string | null;
	peopleHref: string;
	updatesHref: string;
}>();
const query = defineModel<string>('query', { required: true });
const emit = defineEmits<{ 'open-folders': []; 'search-down': [event: KeyboardEvent] }>();

const { t } = useI18n();
const { user } = useAuth();
const { sections, switchToMailbox } = usePostboxMailbox();
const { setClassicInbox } = usePostboxClassicInbox();
const composeNav = usePostboxComposeNav();

const mailboxes = computed(() => [
	...sections.value.personal.map((m) => ({ ...m, icon: MailIcon })),
	...sections.value.team.map((m) => ({ ...m, icon: UsersIcon })),
]);
const current = computed(() => mailboxes.value.find((m) => m.mailboxId === props.mailboxId));
const menuOpen = ref(false);

function startNew() {
	void composeNav.open({
		mailboxId: props.mailboxId,
		...(props.newTo ? { prefillTo: [props.newTo] } : {}),
	});
}

const firstName = computed(() => user.value?.name?.trim().split(/\s+/)[0] ?? '');
const named = computed(() => props.waiting.slice(0, 2));
const others = computed(() => Math.max(0, props.waiting.length - named.value.length));

const searchEl = ref<HTMLInputElement | null>(null);
function onWindowKeydown(event: KeyboardEvent) {
	if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target) || isDialogOpen() || event.defaultPrevented) return;
	// On a phone the pane hides behind an open page; its field is not there to focus.
	if (!searchEl.value?.offsetParent) return;
	event.preventDefault();
	searchEl.value.focus();
}
// oxlint-disable-next-line owlat/no-raw-keydown-listener -- `/` focuses this pane's own search field, which only exists while the conversation view is on screen
onMounted(() => window.addEventListener('keydown', onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown));
const searchAllHref = computed(
	() => `/dashboard/postbox/search?q=${encodeURIComponent(query.value.trim())}`
);
function onSearchKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && query.value.trim()) {
		event.preventDefault();
		void navigateTo(searchAllHref.value);
	} else if (event.key === 'ArrowDown') {
		emit('search-down', event);
	} else if (event.key === 'Escape' && query.value) {
		event.preventDefault();
		query.value = '';
	}
}
</script>

<template>
	<header class="flex flex-col gap-3 px-4 pb-2.5 pt-4">
		<div class="flex items-center gap-2">
			<UiDropdownMenu v-model:open="menuOpen" position="left" class="min-w-0 flex-1">
				<template #trigger>
					<button
						type="button"
						class="-ml-1.5 flex min-h-9 max-w-full items-baseline gap-1.5 rounded-lg px-1.5 text-left hover:bg-bg-surface"
						:aria-label="t('components.postbox.conversations.pane.mailboxMenu')"
					>
						<span class="truncate text-[0.9375rem] font-semibold text-text-primary">
							{{ current?.label ?? t('components.postbox.conversations.pane.inbox') }}
						</span>
						<span
							v-if="mailboxAddress"
							class="hidden truncate text-xs text-text-tertiary sm:inline"
						>
							{{ mailboxAddress }}
						</span>
						<ChevronDownIcon class="h-3 w-3 flex-shrink-0 self-center text-text-tertiary" />
					</button>
				</template>
				<template v-if="mailboxes.length > 1">
					<UiDropdownMenuItem
						v-for="mb in mailboxes"
						:key="mb.mailboxId"
						:icon="mb.icon"
						@click="switchToMailbox(mb.mailboxId)"
					>
						<span
							class="flex-1 truncate text-left"
							:class="mb.mailboxId === mailboxId ? 'font-semibold text-text-primary' : ''"
							>{{ mb.label }}</span
						>
						<span v-if="mb.unread > 0" class="text-xs text-text-tertiary">{{
							mb.unread > 99 ? '99+' : mb.unread
						}}</span>
					</UiDropdownMenuItem>
					<UiDropdownDivider />
				</template>
				<UiDropdownMenuItem :icon="PaperPlaneIcon" @click="navigateTo('/dashboard/postbox/sent')">
					{{ t('components.postbox.conversations.pane.sent') }}
				</UiDropdownMenuItem>
				<UiDropdownMenuItem :icon="ArchiveIcon" @click="navigateTo('/dashboard/postbox/archive')">
					{{ t('components.postbox.conversations.pane.archive') }}
				</UiDropdownMenuItem>
				<UiDropdownMenuItem :icon="FoldersIcon" @click="emit('open-folders')">
					{{ t('components.postbox.conversations.pane.folders') }}
				</UiDropdownMenuItem>
				<UiDropdownDivider />
				<UiDropdownMenuItem :icon="ColumnsIcon" @click="setClassicInbox(true)">
					{{ t('components.postbox.conversations.pane.traditional') }}
				</UiDropdownMenuItem>
			</UiDropdownMenu>
			<button
				type="button"
				class="flex-shrink-0 rounded-lg bg-brand px-3 py-1.5 text-[0.8125rem] font-semibold text-text-inverse hover:bg-brand-hover"
				@click="startNew"
			>
				{{ t('components.postbox.conversations.pane.new') }}
			</button>
		</div>

		<p
			v-if="view === 'people' && named.length > 0"
			class="text-[0.8125rem] leading-snug text-text-secondary"
		>
			<i18n-t
				:keypath="
					others > 0
						? 'components.postbox.conversations.greeting.many'
						: named.length === 2
							? 'components.postbox.conversations.greeting.two'
							: 'components.postbox.conversations.greeting.one'
				"
				scope="global"
			>
				<template #hello>{{
					firstName
						? t('components.postbox.conversations.greeting.helloNamed', { name: firstName })
						: t('components.postbox.conversations.greeting.hello')
				}}</template>
				<template v-for="(person, i) in named" :key="person.key" #[`name${i}`]>
					<NuxtLink
						:to="person.href"
						class="font-semibold text-brand-muted underline decoration-brand-border underline-offset-2 hover:decoration-brand"
						>{{ person.name }}</NuxtLink
					>
				</template>
				<template #count>{{ others }}</template>
			</i18n-t>
		</p>

		<nav
			class="grid grid-cols-3 gap-0.5 rounded-lg bg-bg-soft p-[3px]"
			:aria-label="t('components.postbox.conversations.pane.views')"
		>
			<NuxtLink
				:to="peopleHref"
				class="rounded-md py-1 text-center text-[0.8125rem] max-lg:py-2.5"
				:class="
					view === 'people'
						? 'bg-bg-base font-semibold text-text-primary shadow-sm'
						: 'font-medium text-text-secondary hover:text-text-primary'
				"
				:aria-current="view === 'people' ? 'page' : undefined"
				>{{ t('components.postbox.conversations.pane.people') }}</NuxtLink
			>
			<NuxtLink
				:to="updatesHref"
				class="rounded-md py-1 text-center text-[0.8125rem] max-lg:py-2.5"
				:class="
					view === 'updates'
						? 'bg-bg-base font-semibold text-text-primary shadow-sm'
						: 'font-medium text-text-secondary hover:text-text-primary'
				"
				:aria-current="view === 'updates' ? 'page' : undefined"
				>{{ t('components.postbox.conversations.pane.updates')
				}}<span v-if="updatesUnread > 0" class="ml-1 text-[0.6875rem] text-brand-muted">{{
					updatesUnread > 99 ? '99+' : updatesUnread
				}}</span></NuxtLink
			>
			<NuxtLink
				to="/dashboard/postbox/drafts"
				class="rounded-md py-1 text-center text-[0.8125rem] max-lg:py-2.5 font-medium text-text-secondary hover:text-text-primary"
				>{{ t('components.postbox.conversations.pane.drafts') }}</NuxtLink
			>
		</nav>

		<label class="input input-sm flex items-center gap-2">
			<SearchIcon class="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
			<input
				ref="searchEl"
				v-model="query"
				type="search"
				class="input-bare min-w-0 flex-1 text-[0.8125rem]"
				:placeholder="t('components.postbox.conversations.pane.search')"
				:aria-label="t('components.postbox.conversations.pane.search')"
				@keydown="onSearchKeydown"
			/>
			<kbd
				v-if="!query"
				class="rounded border border-border-default px-1 font-sans text-[0.6875rem] text-text-tertiary max-lg:hidden"
				>/</kbd
			>
		</label>
	</header>
</template>
