<script setup lang="ts">
/**
 * One row of the conversation pane: a person, a company (its people and
 * departments nested under a chevron), a group conversation, or a company's
 * member. The name, when it happened, and the latest words with who wrote
 * them. Unread is weight; nothing else is marked here, because whether a
 * reply is due is said on the conversation itself.
 */
import { CaretDownIcon, CaretRightIcon } from '@coolicons/vue';
import type { TopicLine } from '~/utils/postboxConversations';
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';

type Mark =
	| { kind: 'person'; name: string; colorKey: string }
	| { kind: 'company'; name: string; logoUrl?: string }
	| { kind: 'pair'; first: { name: string; key: string }; second: { name: string; key: string } };

const props = defineProps<{
	href: string;
	name: string;
	/** "+1" after a group's names. */
	more?: number;
	mark: Mark;
	lastAt: number;
	isUnread: boolean;
	line: TopicLine | null;
	isSelected: boolean;
	isShared: boolean;
	/** Nothing open: a search result, labelled so. */
	isDone?: boolean;
	/** A member row, indented under its company. */
	isNested?: boolean;
	/** A company row's disclosure; absent on every other row. */
	disclosure?: 'open' | 'closed';
}>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const stamp = usePostboxThreadTimestamp();
const author = computed(() =>
	props.line
		? (props.line.author ??
			(props.isShared
				? t('components.postbox.conversations.line.team')
				: t('components.postbox.conversations.line.you')))
		: null
);
</script>

<template>
	<div class="relative">
		<NuxtLink
			:to="href"
			data-pane-row
			:aria-current="isSelected ? 'page' : undefined"
			class="group relative flex items-center gap-3 pr-4 outline-none transition-colors hover:bg-bg-surface-hover focus-visible:bg-bg-surface-hover"
			:class="[
				isNested ? 'min-h-[3.25rem] py-2 pl-14' : 'min-h-16 py-3 pl-4',
				isSelected ? 'bg-bg-surface' : '',
			]"
		>
			<span
				v-if="isSelected"
				class="absolute inset-y-2.5 left-0 w-[3px] rounded-r bg-brand"
				aria-hidden="true"
			/>
			<span v-if="mark.kind === 'pair'" class="relative h-9 w-9 flex-shrink-0" aria-hidden="true">
				<PostboxPeopleAvatar
					class="absolute left-0 top-0"
					kind="person"
					size="sm"
					:name="mark.first.name"
					:color-key="mark.first.key"
				/>
				<PostboxPeopleAvatar
					class="absolute bottom-0 right-0 rounded-full ring-2 ring-bg-elevated"
					kind="person"
					size="sm"
					:name="mark.second.name"
					:color-key="mark.second.key"
				/>
			</span>
			<PostboxPeopleAvatar
				v-else
				:kind="mark.kind"
				:size="isNested ? 'sm' : 'md'"
				:name="mark.name"
				:color-key="mark.kind === 'person' ? mark.colorKey : undefined"
				:logo-url="mark.kind === 'company' ? mark.logoUrl : undefined"
			/>
			<span class="min-w-0 flex-1">
				<span class="flex items-baseline gap-2">
					<span
						class="min-w-0 flex-1 truncate text-[0.9375rem] text-text-primary"
						:class="[isUnread ? 'font-bold' : 'font-medium', disclosure ? 'pl-5' : '']"
					>
						{{ name }}<span v-if="more" class="font-normal text-text-tertiary"> +{{ more }}</span>
					</span>
					<span v-if="isDone" class="flex-shrink-0 text-xs font-medium text-text-tertiary">
						{{ t('components.postbox.conversations.done.label') }}
					</span>
					<span class="flex-shrink-0 text-xs tabular-nums text-text-tertiary">
						{{ stamp(lastAt) }}
					</span>
				</span>
				<span
					v-if="line"
					class="mt-0.5 block truncate text-[0.8125rem]"
					:class="isUnread ? 'text-text-primary' : 'text-text-secondary'"
				>
					<span class="font-semibold">{{ author }}:</span> {{ line.text }}
				</span>
			</span>
		</NuxtLink>
		<!-- The disclosure sits over the row's name, apart from the link, so
		     opening the company and showing its people are two targets. -->
		<button
			v-if="disclosure"
			type="button"
			class="absolute left-[3.75rem] top-3 flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
			:aria-expanded="disclosure === 'open'"
			:aria-label="
				disclosure === 'open'
					? t('components.postbox.conversations.pane.hideMembers', { name })
					: t('components.postbox.conversations.pane.showMembers', { name })
			"
			@click="emit('toggle')"
		>
			<CaretDownIcon v-if="disclosure === 'open'" class="h-3.5 w-3.5" />
			<CaretRightIcon v-else class="h-3.5 w-3.5" />
		</button>
	</div>
</template>
