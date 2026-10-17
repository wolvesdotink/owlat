<script setup lang="ts">
/**
 * The calm reader's one element under the header (read on arrival §3, plan
 * §6 "The reader"): the brief strip, or the slim "Why here? · Details" line
 * that takes its place when there is nothing to say yet. Which one is decided
 * by `resolveReaderStrip` (utils/postboxReaderStrip); this renders it.
 *
 *   brief   the lead (the brief's first "Latest update" line, or the gist
 *           quoted verbatim with its sender), the first item you owe with
 *           Reply and Done, then the meta row: the first item you wait on,
 *           Full brief, Why here?, Details, and a quiet summary on the right.
 *   gist    gist-depth mail: the quoted gist line and the meta row.
 *   meta    "Why here? · Details", with "Reading this thread now" in front
 *           while this open is what reads it. No skeleton, ever: the strip
 *           fades in when the brief is ready.
 *
 * Details is collapsible (`detailsOpen`, owned by the host so the header ⋯
 * can open it too). Its panel is always mounted, only hidden, because the
 * host teleports the latest message's chips into it (`detailsEl`).
 *
 * "Why here?" is the seam lane learn fills (usePostboxWhyHere); here it only
 * emits, with the link as the popover's anchor.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import type { ReaderStrip } from '~/utils/postboxReaderStrip';
import type { BriefAction } from '~/utils/threadBriefItems';
import { briefDueDate } from '~/utils/threadBriefContext';

const props = defineProps<{
	strip: ReaderStrip;
	/** The gist's sender, for the attribution after the quote. */
	gistAttribution: string;
	detailsOpen: boolean;
	/** "signed · images off": what Details holds, in a few quiet words. */
	summary?: string | null;
	/** Offer "Why here?" (personal mailboxes only). */
	showWhyHere?: boolean;
	/** Offer "Read the exact wording" (the brief lists such a message). */
	hasExactWording?: boolean;
}>();

const emit = defineEmits<{
	'update:detailsOpen': [open: boolean];
	'why-here': [anchor: HTMLElement | null];
	'full-brief': [];
	'exact-wording': [];
	react: [item: BriefItemView, action: BriefAction];
}>();

const { t, locale } = useI18n();

const detailsEl = ref<HTMLElement | null>(null);
defineExpose({ detailsEl });

const isCard = computed(() => props.strip.kind !== 'meta');
const lead = computed(() => {
	const s = props.strip;
	if (s.kind === 'gist') return { kind: 'gist' as const, gist: s.gist };
	return s.kind === 'brief' ? s.lead : null;
});
const owe = computed(() => (props.strip.kind === 'brief' ? props.strip.owe : null));
const waiting = computed(() => (props.strip.kind === 'brief' ? props.strip.waiting : null));
const oweDue = computed(() =>
	owe.value?.due?.at !== undefined ? briefDueDate(owe.value.due.at, locale.value) : null
);
const waitingLine = computed(() => {
	const item = waiting.value;
	if (!item) return '';
	const name = item.responsible.name?.trim();
	return name
		? t('postbox.reader.strip.waitingOn', { name, text: item.text })
		: t('postbox.reader.strip.waiting', { text: item.text });
});
const note = computed(() => (props.strip.kind === 'meta' ? props.strip.note : null));

/** The meta row's props and handlers, one set for both renderings. */
const linkProps = computed(() => ({
	showFullBrief: props.strip.kind === 'brief',
	hasExactWording: props.hasExactWording,
	showWhyHere: props.showWhyHere,
	detailsOpen: props.detailsOpen,
	summary: props.summary,
}));
const linkHandlers = {
	onToggleDetails: () => emit('update:detailsOpen', !props.detailsOpen),
	onWhyHere: (anchor: HTMLElement | null) => emit('why-here', anchor),
	onFullBrief: () => emit('full-brief'),
	onExactWording: () => emit('exact-wording'),
};
</script>

<template>
	<section
		class="pbx-reader-strip mb-3"
		:class="isCard ? 'rounded-xl border border-border-subtle bg-bg-elevated px-4 py-3' : ''"
		data-reader-chrome="strip"
		:data-strip="strip.kind"
	>
		<Transition name="pbx-fade" mode="out-in">
			<div v-if="isCard" key="strip" class="space-y-2" data-testid="reader-strip">
				<p
					v-if="lead?.kind === 'latest'"
					class="text-sm text-text-primary"
					data-testid="strip-lead"
				>
					{{ lead.text }}
				</p>
				<p
					v-else-if="lead?.kind === 'gist'"
					class="text-sm text-text-primary"
					data-testid="strip-gist"
				>
					<q>{{ lead.gist.quotes.join(' … ') }}</q
					><span v-if="gistAttribution" class="text-text-tertiary"> — {{ gistAttribution }}</span>
				</p>
				<div
					v-if="owe"
					class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
					data-testid="strip-owe"
				>
					<span
						class="size-3.5 flex-shrink-0 rounded-full border-[1.5px] border-brand"
						aria-hidden="true"
					/>
					<span class="min-w-0 flex-1 text-text-primary">{{ owe.text }}</span>
					<span v-if="oweDue" class="text-xs font-medium text-error">{{
						t('postbox.reader.strip.due', { date: oweDue })
					}}</span>
					<span class="ml-auto flex items-center gap-1">
						<UiButton size="sm" data-testid="strip-owe-reply" @click="emit('react', owe, 'reply')">
							{{ t('postbox.reader.strip.reply') }}
						</UiButton>
						<UiButton
							size="sm"
							variant="ghost"
							data-testid="strip-owe-done"
							@click="emit('react', owe, 'markDone')"
						>
							{{ t('postbox.reader.strip.done') }}
						</UiButton>
					</span>
				</div>
				<PostboxReaderStripLinks
					v-bind="{ ...linkProps, ...linkHandlers }"
					data-testid="strip-meta"
				>
					<template v-if="waiting">
						<span class="text-text-secondary" data-testid="strip-waiting">{{ waitingLine }}</span>
						<span aria-hidden="true">·</span>
					</template>
				</PostboxReaderStripLinks>
			</div>
			<PostboxReaderStripLinks
				v-else
				key="meta"
				v-bind="{ ...linkProps, ...linkHandlers }"
				data-testid="reader-meta-line"
			>
				<template v-if="note === 'reading'">
					<span data-testid="meta-reading">{{ t('postbox.reader.strip.reading') }}</span>
					<span aria-hidden="true">·</span>
				</template>
			</PostboxReaderStripLinks>
		</Transition>
		<!-- Always mounted: the host teleports the latest message's chips in here. -->
		<div
			v-show="detailsOpen"
			ref="detailsEl"
			class="mt-2 space-y-2 border-t border-border-subtle pt-2 text-sm"
			data-testid="strip-details-panel"
		>
			<slot name="details" />
		</div>
	</section>
</template>
