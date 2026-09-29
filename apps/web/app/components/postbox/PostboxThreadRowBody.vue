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
 */
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import { senderRowMarkerOf } from '~/utils/senderAuth';

const { t, locale } = useI18n();

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
	<PostboxRowCore :unread="!msg.flagSeen">
		<template #identifier>{{ sender }}</template>
		<template #meta>{{ formatThreadTimestamp(msg.receivedAt) }}</template>
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
		<p v-if="!compact" class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
			{{ msg.snippet }}
		</p>
	</PostboxRowCore>
</template>
