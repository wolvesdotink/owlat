<script setup lang="ts">
/**
 * Honest sender-authentication badge for the reader (Sealed Mail A3, flag
 * `senderAuthBadges`). Modeled on PostboxSecurityBadge: quiet when the sender
 * is verified, expandable for the plain-language detail; louder (warn/danger)
 * when the sender can't be verified or is impersonating a domain.
 *
 * Every string it can render is derived by `deriveSenderAuth` and maps 1:1 to a
 * checked condition — the derivation unit test is the honesty audit. When the
 * flag is off, or there are no verdicts to reason about (a legacy row), it
 * renders nothing.
 */
import {
	deriveOstrChip,
	deriveSenderAuth,
	deriveSenderHeuristicLines,
	type OstrChip,
	type SenderAuthInput,
	type SenderAuthResult,
	type SenderHeuristics,
} from '~/utils/senderAuth';

const props = defineProps<{
	/** Feature-flag gate: when false the badge renders nothing. */
	enabled: boolean;
	auth: SenderAuthInput;
	/**
	 * Ingest-computed sender-impersonation heuristics (Sealed Mail A4). Rendered
	 * as secondary detail lines under the main explanation — never a second
	 * badge. Absent / all-clear contributes no lines.
	 */
	heuristics?: SenderHeuristics;
	/** Feature-flag gate for the OSTR chip (`ostr`), decided by the reader. */
	ostrEnabled?: boolean;
	/**
	 * The sender's OSTR registry tier persisted at delivery
	 * (`mailMessages.ostrTier`). Absent — or `unknown` — renders no chip.
	 */
	ostrTier?: string;
}>();

const { t } = useI18n();

/**
 * Every string this badge shows is derived by the module-scope `senderAuth`
 * registry, so it arrives as a message key (or a `{ key, params }` pair for the
 * parameterized lines) and is resolved here at render time.
 */
type Message = string | { key: string; params?: Record<string, unknown> };
const message = (value: Message) =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const result = computed(() => (props.enabled ? deriveSenderAuth(props.auth) : null));

// Secondary impersonation lines, shown only when the badge itself renders (a
// legacy row with no verdicts stays silent). Each line maps 1:1 to a fired flag.
const heuristicLines = computed(() =>
	props.enabled ? deriveSenderHeuristicLines(props.heuristics) : []
);

// The OSTR registry tier, behind its own flag. A separate signal from the auth
// verdicts (see `deriveOstrChip`), so it gets its own chip rather than folding
// into the summary — but it lives inside this badge, and an absent / `unknown`
// tier stays silent.
//
// DEFERRED, deliberately: plan 12.2 also asks for a click-through to the public
// evidence page, and this chip ships inert. The wire contract persists exactly
// one field — `mailMessages.ostrTier` — with no subject reference and no
// evidence URL, and the aggregator's address is server-side config. A link
// synthesised here from the sender domain alone would point at a page that may
// hold different evidence than the tier this row was stamped with, i.e. it would
// claim more than the row carries, which is the one thing this badge may never
// do. It becomes a link when the row carries an evidence reference.
const ostrChip = computed(() => (props.ostrEnabled ? deriveOstrChip(props.ostrTier) : null));

// Quiet by default when verified; the warn/danger states start expanded so the
// reader sees why without having to reach for it. Watch the derived STATE (a
// primitive) rather than the result object: the parent passes a fresh `auth`
// object on every render, so keying off object identity would re-snap the
// reader's manual expand/collapse on any unrelated re-render.
const expanded = ref(false);
watch(
	[() => result.value?.state, () => heuristicLines.value.length, () => ostrChip.value?.tone],
	([state, lineCount, ostrTone]) => {
		// Expand when there is something the reader should not have to reach for:
		// any non-trustworthy state, OR an impersonation heuristic fired even on an
		// otherwise-trustworthy sender (a verified domain can still be a look-alike
		// of a contact). The trustworthy states — a directly-verified sender and a
		// trusted-forwarder ARC rescue ('forwarded') — stay quiet with no
		// heuristics, so a rescued mailing-list message never reads as suspicious.
		// A warned / flagged registry tier counts as such a signal too: an
		// authenticated sender can still have a bad public record.
		const trustworthy = state === 'verified' || state === 'forwarded';
		const ostrConcern = ostrTone === 'warn' || ostrTone === 'danger';
		expanded.value = state ? !trustworthy || lineCount > 0 || ostrConcern : false;
	},
	{ immediate: true }
);

// One table keyed by the tone discriminator so chip and icon styling never
// drift apart. FF tokens only.
const TONE_CLASSES: Record<SenderAuthResult['tone'], { chip: string; icon: string }> = {
	ok: { chip: 'border-border-subtle text-text-secondary', icon: 'text-success' },
	warn: { chip: 'border-warning/40 text-warning', icon: 'text-warning' },
	danger: { chip: 'border-error/40 text-error', icon: 'text-error' },
};
const FALLBACK_TONE = {
	chip: 'border-border-subtle text-text-secondary',
	icon: 'text-text-tertiary',
};

const toneClasses = computed(() => {
	const tone = result.value?.tone;
	return tone ? TONE_CLASSES[tone] : FALLBACK_TONE;
});

// The registry chip reuses the same table, so the two chips can never drift
// apart, plus the one tone only it has: `neutral` for `establishing`, a tier
// with real but short evidence. It gets the quiet chip and a NON-green icon, so
// a sender still building a history is visibly not a sender that has one.
const OSTR_TONE_CLASSES: Record<OstrChip['tone'], { chip: string; icon: string }> = {
	...TONE_CLASSES,
	neutral: FALLBACK_TONE,
};

const ostrToneClasses = computed(() => {
	const tone = ostrChip.value?.tone;
	return tone ? OSTR_TONE_CLASSES[tone] : FALLBACK_TONE;
});
</script>

<template>
	<div v-if="result" class="mt-2" data-testid="auth-badge">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
			:class="toneClasses.chip"
			:aria-expanded="expanded"
			data-testid="auth-badge-toggle"
			@click="expanded = !expanded"
		>
			<Icon :name="result.icon" class="w-3.5 h-3.5" :class="toneClasses.icon" />
			<span data-testid="auth-badge-summary">{{ message(result.summary) }}</span>
			<Icon
				:name="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="w-3 h-3 text-text-tertiary"
			/>
		</button>
		<span
			v-if="ostrChip"
			class="ml-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border"
			:class="ostrToneClasses.chip"
			data-testid="auth-badge-ostr"
		>
			<Icon name="lucide:globe" class="w-3.5 h-3.5" :class="ostrToneClasses.icon" />
			<span>{{ t(ostrChip.labelKey) }}</span>
		</span>
		<p
			v-if="expanded"
			class="mt-1.5 text-xs text-text-secondary max-w-prose"
			data-testid="auth-badge-detail"
		>
			{{ message(result.detail) }}
		</p>
		<p
			v-if="expanded && ostrChip"
			class="mt-1.5 text-xs text-text-secondary max-w-prose"
			data-testid="auth-badge-ostr-detail"
		>
			{{ t(ostrChip.detailKey) }}
		</p>
		<ul
			v-if="expanded && heuristicLines.length"
			class="mt-1.5 space-y-1 text-xs text-text-secondary max-w-prose list-disc pl-4"
			data-testid="auth-badge-heuristics"
		>
			<li v-for="(line, i) in heuristicLines" :key="i">{{ message(line) }}</li>
		</ul>
	</div>
</template>
