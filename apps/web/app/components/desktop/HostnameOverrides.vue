<script setup lang="ts">
/**
 * "Advanced: customize hostnames" disclosure for the server-setup wizard.
 *
 * Exposes the five subdomain LABELS (`owlat`, `api`, `rest.api`, `mail`,
 * `bounce`) as editable inputs, prefilled with their defaults and collapsed by
 * default. It never derives hostnames itself: it hands its labels back through
 * `v-model` and previews the result with the shared {@link deriveHostnames} —
 * the one place labels become hostnames — so the wizard's DNS records, generated
 * config and network URLs stay in lockstep and cannot drift.
 *
 * Validation (charset/length + mutual distinctness) is computed by the parent
 * with `validateSubdomainLabels` and passed in via `errors`, so the same
 * verdict gates provisioning and paints the inline messages.
 *
 * A label can be inert for the current configuration (mail/bounce only matter
 * for the self-hosted MTA). The parent marks those `disabledKeys`; the field
 * stays visible but is disabled with `disabledHint` so the operator is never
 * invited to edit an input that does nothing.
 */
import {
	deriveHostnames,
	SUBDOMAIN_FIELDS,
	type SubdomainKey,
	type SubdomainLabels,
} from '~/lib/desktop/provisioning';

const props = withDefaults(
	defineProps<{
		/** The apex domain the labels expand against, for the live preview. */
		domain: string;
		/** Inline errors keyed by field (from `validateSubdomainLabels`). */
		errors: Partial<Record<SubdomainKey, string>>;
		/** Labels that are inert for the current config — rendered disabled. */
		disabledKeys?: SubdomainKey[];
		/** Why the disabled fields are inert (shown in place of the preview). */
		disabledHint?: string;
	}>(),
	{ disabledKeys: () => [], disabledHint: '' },
);

/** The current label values (two-way bound; the parent seeds the defaults). */
const labels = defineModel<SubdomainLabels>({ required: true });

const open = ref(false);

const isDisabled = (key: SubdomainKey): boolean => props.disabledKeys.includes(key);

/** Reassign the whole model so the update propagates cleanly on every keystroke. */
function setLabel(key: SubdomainKey, value: string): void {
	labels.value = { ...labels.value, [key]: value };
}

/** The full hostname each label currently resolves to (via the one derivation). */
const preview = computed(() => deriveHostnames(props.domain, labels.value));

const inputBase =
	'w-full rounded-lg border bg-bg-deep px-3 py-2 font-mono text-xs text-text-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
</script>

<template>
	<div>
		<button
			type="button"
			class="text-xs text-text-secondary hover:text-text-primary"
			:aria-expanded="open"
			aria-controls="hostname-overrides-panel"
			@click="open = !open"
		>
			{{ open ? '−' : '+' }} Advanced: customize hostnames
		</button>

		<div v-show="open" id="hostname-overrides-panel" class="mt-2 space-y-2.5">
			<p class="text-xs text-text-secondary">
				Each label is prepended to your domain. Change one only if the default clashes with an existing
				record — every label must be distinct.
			</p>
			<div v-for="f in SUBDOMAIN_FIELDS" :key="f.key" class="grid grid-cols-[8rem_1fr] items-start gap-2">
				<label :for="`hostname-${f.key}`" class="pt-2 text-xs text-text-secondary">
					{{ f.label }}
					<span class="block text-[11px] text-text-tertiary">{{ f.hint }}</span>
				</label>
				<div>
					<input
						:id="`hostname-${f.key}`"
						:value="labels[f.key]"
						:disabled="isDisabled(f.key)"
						:class="[inputBase, errors[f.key] && !isDisabled(f.key) ? 'border-red-500/60' : 'border-border-default focus:border-brand']"
						:aria-invalid="errors[f.key] && !isDisabled(f.key) ? 'true' : undefined"
						:aria-describedby="`hostname-${f.key}-hint`"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						@input="setLabel(f.key, ($event.target as HTMLInputElement).value)"
					/>
					<p
						v-if="isDisabled(f.key)"
						:id="`hostname-${f.key}-hint`"
						class="mt-1 text-[11px] leading-snug text-text-tertiary"
					>
						{{ disabledHint }}
					</p>
					<p
						v-else-if="errors[f.key]"
						:id="`hostname-${f.key}-hint`"
						class="mt-1 text-[11px] leading-snug text-red-400"
					>
						{{ errors[f.key] }}
					</p>
					<p
						v-else-if="domain.trim()"
						:id="`hostname-${f.key}-hint`"
						class="mt-1 truncate font-mono text-[11px] text-text-tertiary"
					>
						{{ preview[f.key] }}
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
