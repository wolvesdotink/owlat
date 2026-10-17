<script setup lang="ts">
/**
 * The presentational body of a Postbox message row: sender, timestamp, the
 * sender-trust marker, the state chips (star, snoozed, muted, back from snooze,
 * attachment, follow-up), subject and snippet.
 *
 * Every renderer that lists messages builds on this one body — the flat list
 * (PostboxThreadRow), the split inbox (PostboxThreadSectionList) and the
 * bundled feed (PostboxThreadBundleList) — so a row affordance added here shows
 * up in all of them, and a phishing marker cannot go missing in one view.
 *
 * It owns no link, selection, triage or swipe: those stay with the element that
 * wraps it, because only the flat list wires them. Pure presentational.
 *
 * Under the Priority view (`POSTBOX_PRIORITY_ROWS`, read on arrival §3) the
 * row is one line: sender, the brief's lead or ask (else the gist, else the
 * subject; only the subject when the viewer turned the brief off) and one state. Elsewhere a row without a brief line shows the gist
 * in place of the snippet when the thread has one.
 */
import { inject } from 'vue';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import { senderRowMarkerOf } from '~/utils/senderAuth';
import { useLocalized } from '~/composables/useLocalized';
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';
import { briefRowLine } from '~/utils/briefRowLine';
import { rowGistOf } from '~/utils/postboxReaderStrip';
import {
	POSTBOX_PRIORITY_BRIEF_LINES,
	POSTBOX_PRIORITY_ROWS,
	priorityGroupOf,
	priorityRowLine,
} from '~/utils/postboxPriorityGroups';

const { t, locale } = useI18n();
// Ticks with the list's shared minute clock (usePostboxListClock).
const formatTimestamp = usePostboxThreadTimestamp();

const props = defineProps<{
	msg: PostboxThreadRowMessage;
	/**
	 * Flag gate for the danger-only sender-trust marker (`senderAuthBadges`).
	 * Resolved once by the list rather than per row, so a folder page does not
	 * mount one flag subscription per visible row.
	 */
	trustMarkers?: boolean;
	/** One line under the header, no snippet (the expanded bundle rows). */
	compact?: boolean;
	/**
	 * The follow-up chip is a cancel button. Only a list that handles
	 * `cancel-follow-up` sets this; elsewhere the chip is a plain indicator, so
	 * no row ever shows a button that does nothing.
	 */
	followUpCancelable?: boolean;
}>();

const emit = defineEmits<{
	'cancel-follow-up': [];
}>();

/** One sender fallback for every renderer: a blank display name reads as absent. */
const sender = computed(() => props.msg.fromName?.trim() || props.msg.fromAddress);

/**
 * Danger-only sender-trust marker (UX plan idea 51). Triage is where phishing
 * gets clicked, and the five-state verdict used to render only inside an opened
 * thread. `deriveSenderRowMarker` stays silent for verified, unauthenticated and
 * legacy rows — the list must not become a wall of shields — so this is null on
 * the overwhelming majority of rows.
 */
const trustMarker = computed(() => senderRowMarkerOf(props.msg, props.trustMarkers));

/**
 * The marker's full sentence, resolved here: the derivation is module scope and
 * hands back catalog keys (`{ key, params }` when it names a domain).
 */
const markerText = useLocalized();

/**
 * The chip's accessible name. The compact density hides the visible label to
 * keep a one-line row one line, so the name has to carry BOTH halves — the
 * short summary and why — or a screen reader would hear a bare warning icon.
 */
const trustMarkerLabel = computed(() => {
	const marker = trustMarker.value;
	if (!marker) return '';
	return `${t(marker.label)} — ${markerText(marker.title)}`;
});

/** The top open item instead of the snippet, once the thread is interpreted (SPEC §7). */
const briefLine = computed(() => briefRowLine(props.msg.briefTop, locale.value));
/** Read on arrival: the gist where a row has no brief line (SPEC §3). */
const gistLine = computed(() => rowGistOf(props.msg.briefTop));

const isPriority = inject(POSTBOX_PRIORITY_ROWS, false);
// The viewer's "Show the brief above conversations": off, the line is the subject.
const showBriefLines = inject(POSTBOX_PRIORITY_BRIEF_LINES, null);
const priorityLine = computed(() =>
	isPriority
		? priorityRowLine(props.msg, priorityGroupOf(props.msg.placement), locale.value, {
				showBrief: showBriefLines?.value !== false,
			})
		: null
);
const priorityState = computed(() => {
	const state = priorityLine.value?.state;
	if (!state || state.kind === 'time') return formatTimestamp(props.msg.receivedAt);
	if (state.kind === 'due') return t('postbox.priority.state.due', { date: state.date });
	return t(`postbox.priority.state.${state.kind}`);
});

/** Absolute wake time of a snoozed row, formatted against the active locale. */
function snoozedTitle(until: number): string {
	return t('components.postbox.postboxThreadRow.snoozedUntil', {
		when: new Date(until).toLocaleString(locale.value),
	});
}

/** Stop the chip's click from following the row's link, then cancel. */
function onCancelFollowUp(event: MouseEvent) {
	event.stopPropagation();
	event.preventDefault();
	emit('cancel-follow-up');
}
</script>

<template>
	<div
		v-if="priorityLine"
		class="flex-1 min-w-0 flex gap-x-3 gap-y-0.5 max-sm:flex-col sm:items-baseline"
		data-testid="priority-row"
	>
		<span
			class="flex items-baseline gap-2 truncate text-sm sm:w-40 sm:flex-shrink-0"
			:class="msg.flagSeen ? 'text-text-secondary' : 'font-semibold text-text-primary'"
		>
			<span class="truncate">{{ sender }}</span>
			<span
				class="ml-auto text-xs font-normal tabular-nums sm:hidden"
				:class="priorityLine.state.kind === 'time' ? 'text-text-tertiary' : 'text-brand'"
				>{{ priorityState }}</span
			>
		</span>
		<span
			class="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-text-secondary"
			:data-source="priorityLine.source"
			data-testid="priority-row-line"
		>
			<Icon
				v-if="trustMarker"
				:name="trustMarker.icon"
				class="w-3.5 h-3.5 flex-shrink-0 text-error"
				:aria-label="trustMarkerLabel"
				data-testid="row-trust-marker"
			/>
			<span class="truncate max-sm:whitespace-normal max-sm:line-clamp-2">{{
				priorityLine.text
			}}</span>
		</span>
		<span
			class="flex-shrink-0 text-xs tabular-nums max-sm:hidden"
			:class="
				priorityLine.state.kind === 'time'
					? 'text-text-tertiary'
					: priorityLine.state.kind === 'waiting'
						? 'text-warning'
						: 'text-brand'
			"
			data-testid="priority-row-state"
			>{{ priorityState }}</span
		>
	</div>
	<PostboxRowCore v-else :unread="!msg.flagSeen">
		<template #identifier>{{ sender }}</template>
		<template #meta>{{ formatTimestamp(msg.receivedAt) }}</template>
		<div class="flex items-center gap-1.5 mt-0.5">
			<!-- Danger-only sender marker: failed / misaligned / look-alike of a
			     known contact's domain. Silent for every other verdict. -->
			<span
				v-if="trustMarker"
				class="pbx-row-trust inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-error/40 text-error whitespace-nowrap flex-shrink-0"
				data-testid="row-trust-marker"
				:title="trustMarkerLabel"
				:aria-label="trustMarkerLabel"
			>
				<Icon :name="trustMarker.icon" class="w-3 h-3" />
				<span class="pbx-row-trust-label">{{ t(trustMarker.label) }}</span>
			</span>
			<Icon v-if="msg.flagFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
			<Icon
				v-if="msg.snoozedUntil"
				name="lucide:clock"
				class="w-3.5 h-3.5 text-brand"
				:title="snoozedTitle(msg.snoozedUntil)"
			/>
			<!-- Muted conversation: the reason this thread is quiet, said
			     out loud rather than left as a mystery. -->
			<Icon
				v-if="msg.mutedAt"
				name="lucide:bell-off"
				class="w-3.5 h-3.5 text-text-tertiary"
				:title="t('components.postbox.postboxThreadRow.mutedChip')"
				:aria-label="t('components.postbox.postboxThreadRow.mutedChip')"
			/>
			<!-- Transient "you asked for this back" cue, cleared on open. -->
			<span
				v-if="msg.snoozeReturnedAt && !msg.snoozedUntil"
				class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border-subtle text-text-tertiary whitespace-nowrap"
			>
				<Icon name="lucide:undo-2" class="w-3 h-3" />
				{{ t('components.postbox.postboxThreadRow.backFromSnooze') }}
			</span>
			<Icon
				v-if="msg.hasAttachments"
				name="lucide:paperclip"
				class="w-3.5 h-3.5 text-text-tertiary"
			/>
			<PostboxThreadRowFollowUp
				v-if="msg.followUp?.watched"
				:follow-up="msg.followUp"
				:cancelable="followUpCancelable"
				@cancel="onCancelFollowUp"
			/>
			<p
				class="truncate text-sm flex-1"
				:class="msg.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
			>
				{{ msg.subject || t('components.postbox.postboxThreadRow.noSubject') }}
			</p>
		</div>
		<p
			v-if="!compact && briefLine"
			class="pbx-row-snippet text-xs text-text-secondary truncate mt-0.5"
			data-testid="row-brief-line"
		>
			<b
				class="font-medium"
				:class="briefLine.tone === 'info' ? 'text-info' : 'text-text-primary'"
				>{{ t(briefLine.leadKey, { count: briefLine.count }, briefLine.count) }}</b
			>
			{{ briefLine.text
			}}<template v-if="briefLine.due"
				>{{ ' ' }}{{ t('components.brief.row.by', { date: briefLine.due }) }}</template
			><template v-if="briefLine.isNoReplyNeeded">
				· {{ t('components.brief.row.noReplyNeeded') }}</template
			><span v-if="briefLine.keepsSnippet && msg.snippet" class="text-text-tertiary">
				· “{{ msg.snippet }}”</span
			>
		</p>
		<p
			v-else-if="!compact"
			class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5"
			:data-testid="gistLine ? 'row-gist-line' : undefined"
		>
			{{ gistLine ?? msg.snippet }}
		</p>
	</PostboxRowCore>
</template>
