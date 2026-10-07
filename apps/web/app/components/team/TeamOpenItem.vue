<script setup lang="ts">
/**
 * One action in the "Open for the team" strip (plan §4.3): its text, what
 * kind of ask it is and who asked, its owner (an avatar, or "Unassigned"),
 * how many notes are about it, then ONE primary button and a ⋯ menu.
 *
 * An unassigned action offers Claim first: taking it assigns it to you and
 * changes nothing else (not who is responsible, not whether it is done). An
 * action someone holds offers its reaction (Reply, Attach…); handing it on
 * is "Assign to…" in the menu. An unconfirmed proposal offers Track.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefDueDate, briefShortDate } from '~/utils/threadBriefContext';
import { menuReactions, type BriefAction } from '~/utils/threadBriefItems';

export interface TeamMember {
	userId: string;
	name: string | null;
	email: string | null;
	image: string | null;
}

export type TeamItemAction = BriefAction | 'claim';

const props = withDefaults(
	defineProps<{
		item: BriefItemView;
		viewerId: string | null;
		members: readonly TeamMember[];
		noteCount?: number;
		/** Read-only (Answer mode's left column): no buttons. */
		hideActions?: boolean;
	}>(),
	{ noteCount: 0, hideActions: false }
);

const emit = defineEmits<{
	act: [action: TeamItemAction];
	assign: [userId: string | null];
}>();

const { t, locale } = useI18n();

const isProposal = computed(() => props.item.verify === 'proposal');
const assignee = computed(() => {
	const id = props.item.assigneeUserId;
	if (!id) return null;
	const m = props.members.find((x) => x.userId === id);
	return { id, name: m?.name || m?.email || t('components.team.items.formerTeammate'), m };
});
const due = computed(() =>
	props.item.due?.at !== undefined ? briefDueDate(props.item.due.at, locale.value) : null
);
const asker = computed(() => props.item.requester.name || props.item.requester.email || null);
const kinds = computed(() =>
	[
		t(`components.brief.intent.${props.item.intent}`),
		...props.item.facets.map((f) => t(`components.brief.facet.${f}`)),
	].join(' · ')
);
const primary = computed<TeamItemAction>(() => {
	if (isProposal.value) return 'confirmProposal';
	if (!props.item.assigneeUserId && props.item.responsibility !== 'them') return 'claim';
	return props.item.primaryReaction;
});
const menu = computed<BriefAction[]>(() => {
	if (isProposal.value) return ['notARequest'];
	const rest = menuReactions(props.item, { isTeam: true }).filter((r) => r !== 'assign');
	return primary.value === 'claim' ? [props.item.primaryReaction, ...rest] : rest;
});
const assignable = computed(() =>
	props.members.filter((m) => m.userId !== props.item.assigneeUserId)
);

function label(action: TeamItemAction): string {
	if (action === 'claim') return t('components.team.items.claim');
	if (action === 'confirmProposal') return t('components.brief.item.track');
	if (action === 'undo') return t('components.brief.item.undo');
	return t(`components.brief.reaction.${action}`);
}
</script>

<template>
	<li
		class="grid grid-cols-[15px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border-subtle py-2 first:border-t-0"
		data-testid="team-open-item"
		:data-responsibility="item.responsibility"
	>
		<span
			class="mt-0.5 size-[15px] rounded-full border-[1.5px] border-border-strong"
			:class="{
				'border-dashed': item.responsibility === 'them',
				'border-dotted': isProposal || item.responsibility === 'unclear',
			}"
			aria-hidden="true"
		/>
		<div class="min-w-0">
			<p class="text-sm text-text-primary">
				{{ isProposal ? `${t('components.brief.item.checkThis')} ${item.text}` : item.text }}
			</p>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary">
				<span v-if="due" class="font-medium text-error">{{
					t('components.brief.item.due', { date: due })
				}}</span>
				<span>{{ kinds }}</span>
				<span v-if="asker">{{
					t('components.team.items.askedBy', {
						name: asker,
						date: briefShortDate(item.askedAt, locale),
					})
				}}</span>
				<span v-if="item.responsibility === 'unclear'" class="text-warning">{{
					t('components.team.items.unclearOwner')
				}}</span>
				<span v-if="item.isReviewNeeded" class="text-warning">{{
					t('components.brief.item.review')
				}}</span>
				<span
					v-if="item.responsibility !== 'them'"
					class="inline-flex items-center gap-1"
					data-testid="team-item-assignee"
				>
					<template v-if="assignee">
						<UiAvatar
							:name="assignee.m?.name ?? assignee.name"
							:email="assignee.m?.email ?? undefined"
							:image="assignee.m?.image ?? undefined"
							deterministic-color
							size="xs"
						/>
						<span class="text-text-secondary">{{ assignee.name }}</span>
					</template>
					<span v-else>{{ t('components.team.items.unassigned') }}</span>
				</span>
				<span v-if="noteCount > 0" data-testid="team-item-notes">{{
					t('components.team.items.notes', { count: noteCount }, noteCount)
				}}</span>
			</p>
		</div>
		<div v-if="!hideActions" class="flex items-center gap-1.5">
			<UiButton
				size="sm"
				variant="ghost"
				data-testid="team-item-primary"
				:data-action="primary"
				@click="emit('act', primary)"
			>
				{{ label(primary) }}
			</UiButton>
			<PostboxOverflowMenu
				:label="t('components.brief.item.menu', { item: item.text })"
				align="right"
			>
				<template #default="{ close }">
					<button
						v-for="action in menu"
						:key="action"
						type="button"
						role="menuitem"
						class="flex w-full items-center px-3 py-1.5 text-left text-sm whitespace-nowrap text-text-primary hover:bg-bg-surface"
						:data-action="action"
						@click="
							emit('act', action);
							close();
						"
					>
						{{ label(action) }}
					</button>
					<template v-if="item.responsibility !== 'them' && !isProposal">
						<p
							class="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-text-tertiary"
						>
							{{ t('components.team.items.assignTo') }}
						</p>
						<button
							v-for="member in assignable"
							:key="member.userId"
							type="button"
							role="menuitem"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary hover:bg-bg-surface"
							data-testid="team-item-assign"
							@click="
								emit('assign', member.userId);
								close();
							"
						>
							<UiAvatar
								:name="member.name ?? undefined"
								:email="member.email ?? undefined"
								:image="member.image ?? undefined"
								deterministic-color
								size="xs"
							/>
							<span class="truncate">{{
								member.userId === viewerId
									? t('components.team.items.me')
									: member.name || member.email
							}}</span>
						</button>
						<button
							v-if="item.assigneeUserId"
							type="button"
							role="menuitem"
							class="flex w-full items-center px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-bg-surface"
							data-testid="team-item-unassign"
							@click="
								emit('assign', null);
								close();
							"
						>
							{{ t('components.team.items.unassign') }}
						</button>
					</template>
				</template>
			</PostboxOverflowMenu>
		</div>
	</li>
</template>
