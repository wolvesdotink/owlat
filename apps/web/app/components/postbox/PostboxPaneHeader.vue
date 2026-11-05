<script setup lang="ts">
/**
 * The top of the conversation pane: which mailbox this is (its menu switches
 * mailboxes and offers the traditional layout), New, a greeting that names
 * who may need a reply, and search.
 *
 * There are no folders here. Search stands in for them: focused and empty,
 * it offers what other mail clients file away (done, sent, drafts, trash,
 * spam) as one-click searches, so nobody has to know an operator.
 *
 * The greeting only speaks when someone is waiting: at most two names, each a
 * link to that person's conversations that may need a reply.
 */
import type { Id } from '@owlat/api/dataModel';
import { ChevronDownIcon, ColumnsIcon, MailIcon, SearchIcon, UsersIcon } from '@coolicons/vue';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	mailboxAddress: string | null;
	/** Who may need a reply, most recent first, each with the link to their open asks. */
	waiting: ReadonlyArray<{ key: string; name: string; href: string }>;
	/** Prefills New with whoever is open. */
	newTo: string | null;
}>();
const query = defineModel<string>('query', { required: true });
const emit = defineEmits<{ 'search-down': [event: KeyboardEvent] }>();

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

const searchHref = (q: string) => `/dashboard/postbox/search?q=${encodeURIComponent(q)}`;
// What a folder bar would list, as searches. "Done" is the Archive: a
// conversation you started and marked done has nothing there, and is found
// by its words or its person instead.
const shortcuts = computed(() =>
	(
		[
			['done', 'in:archive'],
			['sent', 'in:sent'],
			['drafts', 'in:drafts'],
			['trash', 'in:trash'],
			['spam', 'in:spam'],
		] as const
	).map(([id, q]) => ({
		id,
		label: t(`components.postbox.conversations.search.${id}`),
		href: searchHref(q),
	}))
);
const isSearchFocused = ref(false);

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
function onSearchKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && query.value.trim()) {
		event.preventDefault();
		void navigateTo(searchHref(query.value.trim()));
	} else if (event.key === 'ArrowDown') {
		emit('search-down', event);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		if (query.value) query.value = '';
		else searchEl.value?.blur();
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
						class="-ml-1.5 flex min-h-9 max-w-full items-center gap-1.5 rounded-lg px-1.5 text-left hover:bg-bg-surface"
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
						<ChevronDownIcon class="h-3 w-3 flex-shrink-0 text-text-tertiary" />
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
				<UiDropdownMenuItem :icon="ColumnsIcon" @click="setClassicInbox(true)">
					{{ t('components.postbox.conversations.pane.traditional') }}
				</UiDropdownMenuItem>
			</UiDropdownMenu>
			<button
				type="button"
				class="flex-shrink-0 rounded-lg bg-brand px-3 py-1.5 text-[0.8125rem] font-semibold text-text-inverse hover:bg-brand-hover max-lg:py-2.5"
				@click="startNew"
			>
				{{ t('components.postbox.conversations.pane.new') }}
			</button>
		</div>

		<p v-if="named.length > 0" class="text-[0.8125rem] leading-snug text-text-secondary">
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

		<div @focusin="isSearchFocused = true" @focusout="isSearchFocused = false">
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
			<!-- Folders as searches, one each. mousedown keeps the
			     field focused, so the row does not vanish under the click. -->
			<nav
				v-if="isSearchFocused && !query"
				class="mt-2 flex flex-wrap gap-1.5"
				:aria-label="t('components.postbox.conversations.search.label')"
				@mousedown.prevent
			>
				<NuxtLink
					v-for="shortcut in shortcuts"
					:key="shortcut.id"
					:to="shortcut.href"
					class="rounded-full bg-bg-soft px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary max-lg:py-2"
					>{{ shortcut.label }}</NuxtLink
				>
			</nav>
		</div>
	</header>
</template>
