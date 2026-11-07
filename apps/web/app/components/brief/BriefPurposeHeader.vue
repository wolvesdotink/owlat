<script setup lang="ts">
/**
 * What an opened conversation is for, above its messages (the messages are
 * the evidence underneath): one sentence in the brief's own words, whose turn
 * it is, when it is due, and the actions right there. Which sentence is
 * decided by `resolveThreadPurpose` (utils/threadPurpose); this renders it.
 *
 *   ask     the top open item with a source marker, "For you" (or "Open for
 *           the team", "Waiting on Jonas", "Needs review"), the due date and
 *           "2 more" revealing the other open items. Reply, Make task (tied
 *           to the item) and Done, or Track / Not a request for an item the
 *           brief only proposes. Done says it can be undone in its toast.
 *   update  the latest line, with Got it.
 *   review  "Review this conversation": no reading to lead with (AI off, no
 *           brief yet, still reading, the viewer hides AI wording). It never
 *           says there is nothing to do.
 *
 * While the brief is still loading (`pending`) the subject stands in for the
 * sentence, so an open does not flash "Review this conversation" first.
 *
 * The subject is metadata under the sentence. A team surface passes its full
 * list of open items as the `more` slot, so Claim, Assign and notes stay one
 * click away even when only one item is open.
 */
import { provide } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import TaskCreatePopover from '~/components/tasks/TaskCreatePopover.vue';
import EvidenceMarker from '~/components/brief/EvidenceMarker.vue';
import type { TeamItemAction } from '~/components/team/TeamOpenItem.vue';
import { BRIEF_CONTEXT, briefDueDate, type BriefSource } from '~/utils/threadBriefContext';
import { briefActionLabelKey } from '~/utils/threadBriefItems';
import type { PurposeLine, PurposeWho, ThreadPurpose } from '~/utils/threadPurpose';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { ChevronDownIcon } from '@coolicons/vue';

const props = withDefaults(
	defineProps<{
		purpose: ThreadPurpose;
		/** The conversation's subject, shown as metadata under the sentence. */
		subject?: string | null;
		messageCount?: number;
		/** What Make task ties the task to. */
		mailThreadId?: Id<'mailThreads'>;
		conversationThreadId?: Id<'conversationThreads'>;
		/** Who sent a message of the thread and when (the source marker). */
		sourceOf?: (messageId: string) => BriefSource | undefined;
		/** Show where the sentence comes from; without it there is no marker. */
		cite?: (ref: string, quoteIndex: number) => void;
		/** A teammate's name, for an item someone else holds. */
		memberName?: (userId: string) => string;
		/** The shortcut Reply shares (`postbox.reply`, `inbox.reply`). */
		replyShortcut?: string;
		/** The reader's page heading is the sentence; elsewhere it sits under the page's own. */
		headingTag?: 'h1' | 'h2';
		/** Got it was recorded for this update. */
		acknowledged?: boolean;
		/** Offer the `more` slot even with no other open item (a team surface's owner and notes). */
		alwaysOfferMore?: boolean;
		/** The brief has not answered yet. */
		pending?: boolean;
	}>(),
	{
		subject: null,
		messageCount: 0,
		mailThreadId: undefined,
		conversationThreadId: undefined,
		sourceOf: () => undefined,
		cite: undefined,
		memberName: undefined,
		replyShortcut: undefined,
		headingTag: 'h2',
		acknowledged: false,
		alwaysOfferMore: false,
		pending: false,
	}
);

const emit = defineEmits<{
	reply: [];
	act: [item: BriefItemView, action: TeamItemAction];
	'got-it': [];
}>();

const slots = defineSlots<{ more?: () => unknown }>();

provide(BRIEF_CONTEXT, {
	sourceOf: (id) => props.sourceOf(id),
	cite: (ref, quoteIndex) => props.cite?.(ref, quoteIndex),
});

const { t, locale } = useI18n();
const { ariaFor } = useShortcutLabels();
const moreId = useId();
const moreOpen = ref(false);

const item = computed(() => props.purpose.item);

function textOf(line: BriefItemView): string {
	if (line.withdrawn) return `${t('components.brief.item.reviewAgain')} ${line.text}`;
	return line.verify === 'proposal'
		? `${t('components.brief.item.checkThis')} ${line.text}`
		: line.text;
}

const subjectText = computed(
	() => props.subject?.trim() || t('components.brief.purpose.noSubject')
);
/** The subject leads while the brief loads, when the host has one to show. */
const isSubjectLead = computed(() => props.pending && props.subject !== null);

const sentence = computed(() => {
	if (isSubjectLead.value) return subjectText.value;
	if (item.value) return textOf(item.value);
	return props.purpose.sentence ?? t('components.brief.purpose.review');
});

function whoText(who: PurposeWho, line: BriefItemView): string {
	switch (who) {
		case 'forYou':
			return t('components.brief.purpose.who.forYou');
		case 'forTeam':
			return t('components.brief.purpose.who.forTeam');
		case 'assignedToYou':
			return t('components.brief.purpose.who.assignedToYou');
		case 'assignedToOther': {
			const name = line.assigneeUserId ? props.memberName?.(line.assigneeUserId) : undefined;
			return name
				? t('components.brief.purpose.who.assignedTo', { name })
				: t('components.brief.purpose.who.forTeam');
		}
		case 'waitingOnThem': {
			const name = line.responsible.name?.trim();
			return name
				? t('components.brief.purpose.who.waitingOn', { name })
				: t('components.brief.purpose.who.waiting');
		}
		case 'needsReview':
			return t('components.brief.purpose.who.needsReview');
	}
}

const who = computed(() =>
	props.purpose.who && item.value ? whoText(props.purpose.who, item.value) : null
);
const due = computed(() =>
	props.purpose.due !== null ? briefDueDate(props.purpose.due, locale.value) : null
);

/**
 * The item's own verbs beside Reply, with the brief's semantics: a proposal
 * is not an obligation until confirmed (Track, Not a request), a withdrawn
 * item can only be dismissed, an unheld team item can be claimed.
 */
const itemActions = computed<TeamItemAction[]>(() => {
	const it = item.value;
	if (!it) return [];
	if (it.withdrawn) return ['notARequest'];
	if (it.verify === 'proposal') return ['confirmProposal', 'notARequest'];
	return props.purpose.who === 'forTeam' && it.responsibility !== 'them'
		? ['claim', 'markDone']
		: ['markDone'];
});
function actionLabel(action: TeamItemAction): string {
	if (action === 'claim') return t('components.brief.purpose.claim');
	if (action === 'markDone') return t('components.brief.purpose.done');
	return t(briefActionLabelKey(action));
}

const hasMoreSlot = computed(() => !!slots.more);
const isMoreOffered = computed(
	() => props.purpose.more > 0 || (hasMoreSlot.value && props.alwaysOfferMore)
);
const moreLabel = computed(() =>
	props.purpose.more > 0
		? t('components.brief.purpose.more', { count: props.purpose.more }, props.purpose.more)
		: t('components.brief.purpose.ownerAndNotes')
);
/** Open items the loaded pages do not hold: they are in the full brief. */
const unlisted = computed(() => Math.max(0, props.purpose.more - props.purpose.others.length));

const metaLine = computed(() => {
	const parts: string[] = [];
	if (props.subject !== null && !isSubjectLead.value) parts.push(subjectText.value);
	if (props.messageCount > 1) {
		parts.push(
			t('components.brief.purpose.messages', { count: props.messageCount }, props.messageCount)
		);
	}
	return parts.join(' · ');
});

const lineKey = (line: PurposeLine) => line.item.id;
</script>

<template>
	<div class="min-w-0 space-y-2" data-testid="purpose-header" :data-kind="purpose.kind">
		<component
			:is="headingTag"
			class="text-xl font-medium tracking-[-0.01em] text-text-primary text-pretty"
			data-testid="purpose-sentence"
		>
			{{ sentence
			}}<EvidenceMarker
				v-if="purpose.source && cite && purpose.kind !== 'review'"
				:evidence="purpose.source.evidence"
				:cite-ref="purpose.source.ref"
				:quote-index="0"
			/>
		</component>
		<p v-if="metaLine" class="text-sm text-text-tertiary" data-testid="purpose-subject">
			{{ metaLine }}
		</p>

		<p
			v-if="who || due || isMoreOffered"
			class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
		>
			<span v-if="who" class="font-medium text-text-secondary" data-testid="purpose-who">{{
				who
			}}</span>
			<span v-if="who && due" aria-hidden="true" class="text-text-tertiary">·</span>
			<span v-if="due" class="font-medium text-error" data-testid="purpose-due">{{
				t('components.brief.purpose.due', { date: due })
			}}</span>
			<span v-if="(who || due) && isMoreOffered" aria-hidden="true" class="text-text-tertiary"
				>·</span
			>
			<button
				v-if="isMoreOffered"
				type="button"
				class="inline-flex items-center gap-1 rounded text-text-secondary underline-offset-2 outline-none hover:text-text-primary hover:underline focus-visible:ring-1 focus-visible:ring-brand/40"
				:aria-expanded="moreOpen"
				:aria-controls="moreId"
				data-testid="purpose-more"
				@click="moreOpen = !moreOpen"
			>
				{{ moreLabel }}
				<ChevronDownIcon
					class="size-3.5 transition-transform duration-(--motion-fast)"
					:class="{ 'rotate-180': moreOpen }"
					aria-hidden="true"
				/>
			</button>
		</p>

		<div class="flex flex-wrap items-center gap-2 pt-1" data-testid="purpose-actions">
			<UiButton
				v-if="purpose.kind === 'update' && !acknowledged"
				size="sm"
				data-testid="purpose-got-it"
				@click="emit('got-it')"
			>
				{{ t('components.brief.purpose.gotIt') }}
			</UiButton>
			<UiTooltip :text="t('components.brief.purpose.reply')">
				<template v-if="replyShortcut" #shortcut><UiShortcut :id="replyShortcut" /></template>
				<UiButton
					size="sm"
					:variant="purpose.kind === 'update' && !acknowledged ? 'secondary' : 'primary'"
					:aria-keyshortcuts="replyShortcut ? ariaFor(replyShortcut) : undefined"
					data-testid="purpose-reply"
					@click="emit('reply')"
				>
					{{ t('components.brief.purpose.reply') }}
				</UiButton>
			</UiTooltip>
			<TaskCreatePopover
				:mail-thread-id="mailThreadId"
				:conversation-thread-id="conversationThreadId"
				:thread-item-id="item?.id"
				:default-title="item?.text ?? ''"
				size="sm"
				variant="secondary"
			/>
			<UiButton
				v-for="action in itemActions"
				:key="action"
				size="sm"
				variant="ghost"
				:data-testid="`purpose-${action}`"
				@click="item && emit('act', item, action)"
			>
				{{ actionLabel(action) }}
			</UiButton>
			<span
				v-if="purpose.kind === 'update' && acknowledged"
				role="status"
				class="text-xs text-text-tertiary"
				data-testid="purpose-seen"
				>{{ t('components.brief.purpose.seen') }}</span
			>
		</div>

		<div
			v-if="isMoreOffered"
			v-show="moreOpen"
			:id="moreId"
			class="pt-1"
			data-testid="purpose-more-list"
		>
			<slot v-if="hasMoreSlot" name="more" />
			<ul v-else class="space-y-1.5 border-l-2 border-border-subtle pl-3 text-sm">
				<li v-for="line in purpose.others" :key="lineKey(line)" data-testid="purpose-other">
					<span class="text-text-tertiary">{{ whoText(line.who, line.item) }}:</span>&nbsp;<span
						class="text-text-primary"
						>{{ textOf(line.item) }}</span
					><EvidenceMarker
						v-if="cite && line.item.evidence[0]"
						:evidence="line.item.evidence[0]!"
						:cite-ref="line.item.id"
						:quote-index="0"
					/>
				</li>
				<li v-if="unlisted > 0" class="text-text-tertiary" data-testid="purpose-unlisted">
					{{ t('components.brief.purpose.unlisted', { count: unlisted }, unlisted) }}
				</li>
			</ul>
		</div>
	</div>
</template>
