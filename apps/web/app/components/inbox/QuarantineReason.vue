<script setup lang="ts">
/**
 * Why one message sits in quarantine, in the order a human needs it (UX plan
 * idea 53): the outcome first, the individual observations as bullets, and the
 * backend's own vocabulary — the raw `injectionType` enum and the confidence
 * number — demoted to a quiet footer.
 *
 * The page used to lead with "Type: instruction_smuggling / Confidence: 87%",
 * which is the machine's note to itself handed to a non-expert making a security
 * decision. `TrustChip` solved the same problem for agent drafts; this follows
 * it: a module-scope derivation (`utils/quarantineReason.ts`) hands back catalog
 * keys, and the component resolves them at render time.
 *
 * Purely presentational — no fetching, no mutations.
 */
import {
	deriveQuarantineReason,
	type QuarantineSecurityFlags,
	type QuarantineText,
} from '~/utils/quarantineReason';

const props = defineProps<{
	/** The scan record, absent on a row held before any scan wrote one. */
	flags?: QuarantineSecurityFlags;
}>();

const { t } = useI18n();

const reason = computed(() => deriveQuarantineReason(props.flags));

/** Resolve one derived sentence: a bare key, or a key plus its values. */
function say(text: QuarantineText): string {
	return typeof text === 'string' ? t(text) : t(text.key, text.params ?? {});
}
</script>

<template>
	<div class="p-3 bg-error-subtle rounded-lg" data-testid="quarantine-reason">
		<p class="text-sm text-text-primary font-medium" data-testid="quarantine-headline">
			{{ say(reason.headline) }}
		</p>
		<p class="text-xs text-text-secondary font-medium uppercase tracking-wider mt-3">
			{{ t('dashboard.inbox.quarantine.whyHeldLabel') }}
		</p>
		<ul
			class="mt-1 space-y-1 text-sm text-text-secondary list-disc pl-4"
			data-testid="quarantine-reasons"
		>
			<li v-for="(line, i) in reason.reasons" :key="i">{{ say(line) }}</li>
		</ul>
		<!-- The excerpt is evidence quoted from the held message, not copy — it is
		     rendered verbatim as text, never as markup. -->
		<p v-if="reason.sample" class="text-sm text-text-secondary mt-2">
			<span class="font-medium text-text-primary">
				{{ t('dashboard.inbox.quarantine.flaggedContentLabel') }}
			</span>
			<code class="ml-1 px-1.5 py-0.5 bg-bg-surface rounded text-xs break-all">
				{{ reason.sample }}
			</code>
		</p>
		<p
			class="mt-3 pt-2 border-t border-error/20 text-xs text-text-tertiary"
			data-testid="quarantine-footer"
		>
			<span class="sr-only">{{ t('dashboard.inbox.quarantine.footer.heading') }}: </span>
			{{ say(reason.detail) }}
		</p>
	</div>
</template>
