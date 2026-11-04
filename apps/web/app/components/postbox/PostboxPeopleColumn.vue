<script setup lang="ts">
/**
 * The People view's left column: who the mailbox is talking to, in the order
 * they need it. Whoever waits on you first, then who you are in conversation
 * with, then everyone gone quiet (folded away), then the companies: system
 * senders and the companies of two or more people you write with. Search
 * narrows by name, address, company and topic; `/` focuses it, the arrow keys
 * (and j/k) walk the rows.
 */
import {
	PanelLeftIcon,
	SearchIcon,
	ChevronDownIcon,
	CircleHelpIcon,
	CheckIcon,
	CloseIcon,
} from '@coolicons/vue';
import {
	peopleSections,
	type PeopleCompany,
	type PeopleDirectory,
	type PeoplePerson,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { resolveActiveChord } from '~/utils/shortcutScope';
import { isDialogOpen } from '~/utils/dialogOpen';

const props = defineProps<{
	directory: PeopleDirectory | null;
	topics: ReadonlyMap<string, PeopleTopic>;
	companies: ReadonlyMap<string, PeopleCompany>;
	people: ReadonlyMap<string, PeoplePerson>;
	selection: PeopleSelection | null;
	pageHref: (target: PeopleSelection) => string;
	topicHref: (topic: PeopleTopic, from: PeopleSelection | null) => string;
	isLoading: boolean;
	error: Error | null;
}>();
const emit = defineEmits<{ 'open-rail': []; retry: [] }>();

const { t, locale } = useI18n();
const query = ref('');
const showQuiet = ref(false);
const searchEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const isShared = computed(() => props.directory?.scope === 'shared');
const sections = computed(() =>
	props.directory
		? peopleSections(props.directory, query.value)
		: { waiting: [], maybe: [], active: [], quiet: [], companies: [] }
);
const isSearching = computed(() => query.value.trim().length > 0);
const searchAllHref = computed(
	() => `/dashboard/postbox/search?q=${encodeURIComponent(query.value.trim())}`
);

// The classic views stay one click away in the column's own menu, and a
// one-time note tells people who knew the classic inbox where it went.
const viewMenuOpen = ref(false);
const { openClassic } = usePostboxClassicInbox();
const viewOptions = computed(() => [
	{
		id: 'people' as const,
		label: t('components.postbox.people.column.viewPeople'),
		description: t('components.postbox.people.column.viewPeopleHelp'),
	},
	{
		id: 'today' as const,
		label: t('components.postbox.people.column.viewPriority'),
		description: t('components.postbox.people.column.viewPriorityHelp'),
	},
	{
		id: 'browse' as const,
		label: t('components.postbox.people.column.viewAllMail'),
		description: t('components.postbox.people.column.viewAllMailHelp'),
	},
]);
function useClassic(mode: 'today' | 'browse' = 'today') {
	viewMenuOpen.value = false;
	void openClassic(mode);
}
const INTRO_KEY = 'owlat.postbox.peopleIntroSeen';
const showIntro = ref(false);
onMounted(() => {
	showIntro.value = localStorage.getItem(INTRO_KEY) === null;
});
function dismissIntro() {
	showIntro.value = false;
	localStorage.setItem(INTRO_KEY, '1');
}
const isEmpty = computed(() =>
	isSearching.value
		? searchGroups.value.length === 0
		: sections.value.waiting.length +
				sections.value.maybe.length +
				sections.value.active.length +
				sections.value.quiet.length +
				sections.value.companies.length ===
			0
);

const {
	terms,
	peopleCompanies,
	senders,
	shownSenders,
	foldedSenders,
	showAllSenders,
	personRow,
	companyRow,
	searchGroups,
	personGroups,
	expandGroup,
	collapseGroup,
	capped,
	maybeTopics,
} = usePostboxPeopleColumnRows({ props, query, sections, isShared, isSearching });

const bulkNoReply = usePostboxBulkNoReply();
const companiesShown = computed(() => capped('companies', peopleCompanies.value));
/** The Postbox's next/previous keys walk the rows (remaps included); `/` searches. */
const ROW_SCOPES: readonly ShortcutScope[] = ['postbox'];
// The arrows walk the rows as well, so a search result is a key away from the
// field; Escape on a row hands focus back to the query.
function onKeydown(event: KeyboardEvent) {
	if (isEditableTarget(event.target)) return;
	if (event.key === 'Escape' && isSearching.value) {
		event.preventDefault();
		searchEl.value?.focus();
		return;
	}
	const id = resolveActiveChord(chordFromEvent(event), ROW_SCOPES);
	const step =
		id === 'postbox.next' || event.key === 'ArrowDown'
			? 1
			: id === 'postbox.previous' || event.key === 'ArrowUp'
				? -1
				: 0;
	const rows = [...(listEl.value?.querySelectorAll<HTMLElement>('[data-people-row]') ?? [])];
	if (step === 0 || rows.length === 0) return;
	event.preventDefault();
	const index = rows.indexOf(document.activeElement as HTMLElement);
	if (index <= 0 && step < 0 && isSearching.value) {
		searchEl.value?.focus();
		return;
	}
	rows[Math.min(rows.length - 1, Math.max(0, index + step))]?.focus();
}
function firstRow(event: KeyboardEvent) {
	const first = listEl.value?.querySelector<HTMLElement>('[data-people-row]');
	if (!first) return;
	event.preventDefault();
	first.focus();
}
function onWindowKeydown(event: KeyboardEvent) {
	if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target) || isDialogOpen() || event.defaultPrevented) return;
	// Below lg the column hides behind an open page; its search is not there to focus.
	if (!searchEl.value?.offsetParent) return;
	event.preventDefault();
	searchEl.value?.focus();
}
// oxlint-disable-next-line owlat/no-raw-keydown-listener -- `/` focuses this column's own search box, which only exists while the People view is on screen
onMounted(() => window.addEventListener('keydown', onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown));
</script>

<template>
	<section
		class="flex h-full min-h-0 w-full flex-col bg-bg-elevated"
		:aria-label="t('components.postbox.people.column.label')"
	>
		<header class="flex flex-col gap-2.5 border-b border-border-subtle px-3.5 pt-3.5 pb-3">
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="lg:hidden -ml-2 flex h-9 w-9 items-center justify-center rounded text-text-secondary hover:bg-bg-surface hover:text-text-primary"
					:aria-label="t('components.postbox.postboxLayout.openFolders')"
					@click="emit('open-rail')"
				>
					<PanelLeftIcon class="h-4 w-4" />
				</button>
				<h1 class="flex flex-1 items-center gap-1 text-lg font-semibold text-text-primary">
					{{ t('components.postbox.people.column.inbox') }}
					<!-- The marks' key where the list starts, not only at its foot. -->
					<UiTooltip :text="t('components.postbox.people.column.marksHelp')">
						<button
							type="button"
							class="inline-flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
							:aria-label="t('components.postbox.people.column.marksHelp')"
						>
							<CircleHelpIcon class="h-3.5 w-3.5" />
						</button>
					</UiTooltip>
				</h1>
				<UiDropdownMenu v-model:open="viewMenuOpen" wide>
					<template #trigger>
						<!-- Framed at rest: the way to the classic views must read as a control. -->
						<UiButton
							variant="ghost"
							size="sm"
							class="ring-1 ring-inset ring-border-default"
							:aria-label="t('components.postbox.people.column.viewMenu')"
						>
							{{ t('components.postbox.people.column.viewPeople') }}
							<ChevronDownIcon class="h-3.5 w-3.5" />
						</UiButton>
					</template>
					<UiDropdownMenuItem
						v-for="view in viewOptions"
						:key="view.id"
						@click="view.id === 'people' ? (viewMenuOpen = false) : useClassic(view.id)"
					>
						<span class="flex flex-col">
							<!-- The check sits on the label's line, not centred on both lines. -->
							<span
								class="flex items-center gap-1.5"
								:class="view.id === 'people' ? 'font-semibold' : 'pl-5'"
								><CheckIcon v-if="view.id === 'people'" class="h-3.5 w-3.5" />{{ view.label }}</span
							>
							<span class="pl-5 text-2xs text-text-tertiary">{{ view.description }}</span>
						</span>
					</UiDropdownMenuItem>
				</UiDropdownMenu>
			</div>
			<label class="relative block">
				<span class="sr-only">{{ t('components.postbox.people.column.search') }}</span>
				<SearchIcon
					class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary"
				/>
				<input
					ref="searchEl"
					v-model="query"
					type="search"
					:placeholder="t('components.postbox.people.column.search')"
					class="input input-sm w-full pl-8 pr-8"
					@keydown.esc="query = ''"
					@keydown.down="firstRow"
					@keydown.enter="isSearching && navigateTo(searchAllHref)"
				/>
				<kbd
					v-if="!query"
					class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-bg-surface px-1 font-mono text-2xs text-text-tertiary"
					aria-hidden="true"
					>/</kbd
				>
			</label>
			<!-- The column holds recent mail only: with a query, the full search sits
			     right under the field (Enter opens it), not after a long list. -->
			<NuxtLink
				v-if="isSearching"
				:to="searchAllHref"
				class="-mt-1 flex items-center gap-1.5 rounded px-1 text-caption text-text-secondary hover:text-text-primary hover:underline"
			>
				<SearchIcon class="h-3.5 w-3.5 flex-shrink-0" />
				<span class="truncate">{{
					t('components.postbox.people.column.searchAllFor', { query: query.trim() })
				}}</span>
				<kbd
					class="ml-auto rounded bg-bg-surface px-1 font-mono text-2xs text-text-tertiary"
					aria-hidden="true"
					>↵</kbd
				>
			</NuxtLink>
		</header>

		<div ref="listEl" class="flex-1 overflow-y-auto pb-6" @keydown="onKeydown">
			<UiQueryBoundary v-if="error && !directory" :error="error" @retry="emit('retry')" />
			<div v-else-if="isLoading && !directory" class="space-y-3 p-4" aria-busy="true">
				<div v-for="i in 7" :key="i" class="flex items-center gap-3">
					<UiSkeleton circle class="h-9 w-9" />
					<div class="flex-1 space-y-1.5">
						<UiSkeleton class="h-3 w-1/2" />
						<UiSkeleton class="h-3 w-4/5" />
					</div>
				</div>
			</div>
			<div v-else-if="isEmpty" class="px-4 py-10">
				<UiEmptyState
					:variant="isSearching ? 'no-results' : 'empty'"
					:title="
						isSearching
							? t('components.postbox.people.column.noMatch')
							: t('components.postbox.people.column.empty')
					"
					:clear-label="t('components.postbox.people.column.clearSearch')"
					:heading-level="2"
					@clear="query = ''"
				/>
				<div v-if="isSearching" class="mt-3 flex justify-center">
					<UiButton variant="secondary" size="sm" :to="searchAllHref">
						<SearchIcon class="h-3.5 w-3.5" />
						{{ t('components.postbox.people.column.searchAll') }}
					</UiButton>
				</div>
			</div>
			<template v-else>
				<div
					v-if="showIntro"
					class="mx-3.5 mt-3 flex items-start gap-2 rounded-lg bg-bg-overlay px-3 py-2 text-caption text-text-secondary shadow-surface-2"
					role="note"
				>
					<span class="min-w-0 flex-1">
						{{ t('components.postbox.people.column.intro') }}
						<button
							type="button"
							class="font-medium text-brand hover:underline"
							@click="useClassic()"
						>
							{{ t('components.postbox.people.column.introClassic') }}
						</button>
						<!-- The marks' key, where a newcomer meets them first. -->
						<PostboxPeopleMarksKey class="mt-1.5" />
					</span>
					<button
						type="button"
						class="-mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
						:aria-label="t('components.postbox.people.column.introDismiss')"
						@click="dismissIntro"
					>
						<CloseIcon class="h-3.5 w-3.5" />
					</button>
				</div>
				<section v-for="group in personGroups" :key="group.id" :aria-label="group.title">
					<h2
						class="flex items-center px-3.5 pt-4 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						{{ group.title }}
						<!-- Clearing false positives is one step for the group, not one per card. -->
						<UiTooltip :text="t('components.postbox.people.column.noneNeedReplyHelp')">
							<button
								v-if="group.id === 'maybe' && maybeTopics.length > 0"
								type="button"
								class="ml-auto mr-2 rounded-md px-1.5 py-0.5 font-medium normal-case tracking-normal text-text-secondary ring-1 ring-inset ring-border-default hover:bg-bg-surface hover:text-text-primary"
								:disabled="bulkNoReply.isClearing.value"
								@click="bulkNoReply.clearAll(maybeTopics)"
							>
								{{
									t(
										'components.postbox.people.column.noneNeedReply',
										{ count: maybeTopics.length },
										maybeTopics.length
									)
								}}
							</button>
						</UiTooltip>
						<span
							class="font-normal tabular-nums normal-case tracking-normal"
							:class="group.id === 'maybe' && maybeTopics.length > 0 ? '' : 'ml-auto'"
							>{{ group.rows.length + (group.hidden ?? 0) }}</span
						>
					</h2>
					<PostboxPeopleRow v-for="row in group.rows" :key="row.to" v-bind="row" />
					<PostboxPeopleFold
						:hidden="group.hidden ?? 0"
						:can-collapse="group.canCollapse"
						@expand="expandGroup(group.id)"
						@collapse="collapseGroup(group.id)"
					/>
				</section>

				<section
					v-if="sections.quiet.length > 0 && !isSearching"
					:aria-label="t('components.postbox.people.column.quiet')"
				>
					<h2
						class="px-3.5 pt-4 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						{{ t('components.postbox.people.column.quiet') }}
					</h2>
					<template v-if="showQuiet || isSearching">
						<PostboxPeopleRow
							v-for="row in sections.quiet.map(personRow)"
							:key="row.colorKey"
							kind="person"
							v-bind="row"
						/>
					</template>
					<button
						v-else
						type="button"
						class="mx-3.5 flex w-[calc(100%-1.75rem)] items-center gap-2.5 rounded-lg bg-bg-surface px-2.5 py-2 text-left text-caption text-text-secondary hover:bg-bg-surface-hover"
						:aria-expanded="false"
						@click="showQuiet = true"
					>
						<span class="flex -space-x-1.5">
							<PostboxPeopleAvatar
								v-for="person in sections.quiet.slice(0, 3)"
								:key="person.key"
								kind="person"
								:name="person.name"
								:color-key="person.key"
								size="sm"
								class="ring-2 ring-bg-surface rounded-full"
							/>
						</span>
						<span class="flex-1">{{
							t(
								'components.postbox.people.column.quietCount',
								{ count: sections.quiet.length },
								sections.quiet.length
							)
						}}</span>
						<ChevronDownIcon class="h-3.5 w-3.5" />
					</button>
				</section>

				<section
					v-if="peopleCompanies.length > 0 && !isSearching"
					:aria-label="t('components.postbox.people.column.companies')"
				>
					<h2
						class="flex items-center gap-1.5 px-3.5 pt-5 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						{{ t('components.postbox.people.column.companies') }}
						<span class="ml-auto font-normal tabular-nums normal-case tracking-normal">{{
							peopleCompanies.length
						}}</span>
					</h2>
					<PostboxPeopleRow
						v-for="row in companiesShown.rows.map(companyRow)"
						:key="row.to"
						kind="company"
						:more-topics="0"
						v-bind="row"
					/>
					<PostboxPeopleFold
						:hidden="companiesShown.hidden"
						:can-collapse="companiesShown.canCollapse"
						@expand="expandGroup('companies')"
						@collapse="collapseGroup('companies')"
					/>
				</section>
				<section
					v-if="senders.length > 0 && !isSearching"
					:aria-label="t('components.postbox.people.column.senders')"
				>
					<h2
						class="flex items-center gap-1.5 px-3.5 pt-5 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						{{ t('components.postbox.people.column.senders') }}
						<span class="ml-auto font-normal tabular-nums normal-case tracking-normal">{{
							senders.length
						}}</span>
					</h2>
					<PostboxPeopleRow
						v-for="row in shownSenders.map(companyRow)"
						:key="row.to"
						kind="company"
						:more-topics="0"
						v-bind="row"
					/>
					<PostboxPeopleFold
						:hidden="foldedSenders"
						:more-label="
							t(
								'components.postbox.people.column.moreSenders',
								{ count: foldedSenders },
								foldedSenders
							)
						"
						@expand="showAllSenders = true"
					/>
				</section>
				<!-- The marks' key, once, where the list ends: three small shapes should
				     not have to be learned by hovering. -->
				<PostboxPeopleMarksKey v-if="!isSearching" class="px-3.5 pt-6" />
				<p
					v-if="directory?.isOutstandingCapped && !isSearching"
					class="px-3.5 pt-5 text-2xs text-text-tertiary"
				>
					{{ t('components.postbox.people.column.capped') }}
				</p>
			</template>
		</div>
	</section>
</template>
