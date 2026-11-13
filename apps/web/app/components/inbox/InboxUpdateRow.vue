<script lang="ts">
import type { FunctionReturnType } from 'convex/server';
// TYPE-ONLY: the row needs the query's return shape, never the client.
import type { api } from '@owlat/api';

/** One row of the Updates page's `listUpdates` result. */
export type UpdateItem = FunctionReturnType<typeof api.inbox.updates.listUpdates>[number];

export type Tone = 'high' | 'normal' | 'low';
export function importanceTone(item: UpdateItem): Tone {
	const importance = item.message.classification?.importance ?? 0;
	if (item.message.classification?.priority === 'urgent' || importance >= 0.7) return 'high';
	if (importance >= 0.4) return 'normal';
	return 'low';
}

/** Quiet status dot per importance — a tint, never a fill. */
export const DOT_CLASS: Record<Tone, string> = {
	high: 'bg-warning',
	normal: 'bg-brand',
	low: 'bg-text-tertiary/50',
};
export const TONE_ORDER: readonly Tone[] = ['high', 'normal', 'low'];
</script>

<script setup lang="ts">
// One message on the Updates page: the listbox option with its text, and the
// actions beside it. The page owns the list, the keyboard focus and the sweep;
// the row reports which action was pressed.
import { categoryIcon } from '~/utils/agentCategories';
import { formatDateTime } from '~/utils/formatters';
import { CheckIcon, CircleSlashIcon, ExternalLinkIcon, ReplyIcon } from '@coolicons/vue';

const props = defineProps<{
	rowId: string;
	item: UpdateItem;
	/** DOM id of the option, for the listbox's `aria-activedescendant`. */
	optionId: string;
	focused: boolean;
	isSpamView: boolean;
	isAdmin: boolean;
	/** An action on this row is in flight. */
	busy: boolean;
	/** A dismiss sweep has this row in its range. */
	sweptForDismiss: boolean;
}>();

const emit = defineEmits<{
	open: [];
	block: [];
	requestReply: [];
	dismiss: [];
	sweepStart: [event: PointerEvent];
}>();

const { t } = useI18n();

const senderLabel = computed(() => {
	const contact = props.item.contact;
	const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
	return name || props.item.message.from;
});

function categoryLabel(category: string | undefined): string {
	const key = `dashboard.inbox.detail.categories.${category ?? 'other'}`;
	return t(key) === key ? (category ?? '') : t(key);
}

function kindLabel(kind: string | undefined): string | undefined {
	if (!kind) return undefined;
	const key = `dashboard.inbox.updates.kinds.${kind}`;
	return t(key) === key ? undefined : t(key);
}
</script>

<template>
	<li
		role="presentation"
		class="group card p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4"
		:class="focused ? 'ring-2 ring-brand/60' : ''"
		:data-sweep-row="rowId"
		data-testid="update-row"
	>
		<!-- The option holds the text only. Its content is presentational, so
		     the actions are its sibling, where they keep their button role;
		     below sm they drop under the text instead of squeezing it. -->
		<div
			:id="optionId"
			role="option"
			:aria-selected="focused"
			class="flex min-w-0 flex-1 items-start gap-3 outline-none"
			:class="{ 'opacity-40': sweptForDismiss }"
		>
			<UiAvatar
				:name="senderLabel"
				:email="item.message.from"
				size="md"
				deterministic-color
				class="mt-0.5 shrink-0"
			/>
			<div class="min-w-0 flex-1">
				<div class="min-w-0">
					<p class="flex items-center gap-2 text-sm font-semibold text-text-primary">
						<span
							v-if="!isSpamView"
							class="h-1.5 w-1.5 shrink-0 rounded-full"
							:class="DOT_CLASS[importanceTone(item)]"
							:title="t(`dashboard.inbox.updates.importance.${importanceTone(item)}`)"
						/>
						<span class="truncate">{{
							item.message.subject || t('dashboard.inbox.updates.noSubject')
						}}</span>
					</p>
					<p class="mt-0.5 truncate text-caption text-text-tertiary">
						<span class="text-text-secondary">{{ senderLabel }}</span>
						<span class="mx-1 opacity-50">·</span>
						{{ formatDateTime(item.message.receivedAt) }}
						<template v-if="kindLabel(item.message.classification?.kind)">
							<span class="mx-1 opacity-50">·</span>
							{{ kindLabel(item.message.classification?.kind) }}
						</template>
						<template v-if="item.message.classification?.category">
							<span class="mx-1 opacity-50">·</span>
							<component
								:is="categoryIcon(item.message.classification.category)"
								class="inline-block h-3 w-3 align-[-2px]"
							/>
							{{ categoryLabel(item.message.classification.category) }}
						</template>
					</p>
				</div>
				<p
					v-if="item.message.preview"
					class="mt-2 line-clamp-2 text-sm leading-snug text-text-secondary"
					data-testid="update-preview"
				>
					{{ item.message.preview }}
				</p>
			</div>
		</div>
		<div
			v-if="isAdmin"
			class="flex shrink-0 flex-wrap items-center gap-1 opacity-70 pointer-coarse:opacity-100 transition-opacity duration-(--motion-fast) group-hover:opacity-100 group-focus-within:opacity-100"
		>
			<UiButton variant="ghost" size="sm" class="gap-1" :disabled="busy" @click.stop="emit('open')">
				<ExternalLinkIcon class="h-3 w-3" />
				{{ t('dashboard.inbox.updates.open') }}
			</UiButton>
			<UiButton
				v-if="isSpamView"
				variant="ghost"
				size="sm"
				class="gap-1 text-error hover:bg-error-subtle"
				:disabled="busy"
				@click.stop="emit('block')"
			>
				<CircleSlashIcon class="h-3 w-3" />
				{{ t('dashboard.inbox.updates.blockSender') }}
			</UiButton>
			<template v-else>
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1"
					:disabled="busy"
					@click.stop="emit('requestReply')"
				>
					<ReplyIcon class="h-3 w-3" />
					{{ t('dashboard.inbox.updates.requestReply') }}
				</UiButton>
				<UiTooltip :text="t('dashboard.inbox.updates.dismissSweepHint')">
					<UiButton
						variant="secondary"
						size="sm"
						class="gap-1"
						:disabled="busy"
						@pointerdown="emit('sweepStart', $event)"
						@click.stop="emit('dismiss')"
					>
						<CheckIcon class="h-3 w-3" />
						{{ t('dashboard.inbox.updates.dismiss') }}
					</UiButton>
				</UiTooltip>
			</template>
		</div>
	</li>
</template>
