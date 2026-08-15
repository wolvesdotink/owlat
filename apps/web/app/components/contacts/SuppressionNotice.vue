<script setup lang="ts">
/**
 * Inline answer to "why is this contact not getting mail?" — shown at the top of
 * the contact profile when the address is on the suppression list. One
 * warning-subtle line that explains the reason in plain language and, for anyone
 * who can manage contacts, offers the one-click way out (remove the suppression).
 *
 * Presentational only: the profile page owns the query + mutation and passes the
 * reason, a human date label, and the permission flag in. The action is gated on
 * `canManage` here for affordance; the backend re-checks `contacts:manage`.
 */
import { type BlockReason, suppressionReasonPresentation } from '~/utils/suppressionReasons';

const props = defineProps<{
	reason: BlockReason;
	/** Pre-formatted human date the address was suppressed (e.g. "Mar 3"). */
	dateLabel: string;
	/** Whether the viewer may remove suppressions (contacts:manage). */
	canManage: boolean;
	/** Removal in flight. */
	removing?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();

const { t } = useI18n();

/**
 * A presentation field owned by the shared suppression-reason table: either a
 * bare message key or a key plus the values it interpolates.
 */
type LocalizedField = string | { key: string; params?: Record<string, unknown> };
const localize = (value: LocalizedField): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

// Plain language, reason-specific — no jargon, explains WHY in one line. The
// wording comes from the SAME table the suppression list renders from, so the
// two surfaces cannot describe the same reason differently, and a new schema
// literal is a compile error rather than a silent "manually suppressed".
const presentation = computed(() => suppressionReasonPresentation(props.reason));
const reasonPhrase = computed(() => localize(presentation.value.phrase(props.dateLabel)));
// The headline is reason-specific too: an `unengaged` row is marketing-only, so
// that address still gets transactional mail, DOI confirmations and 1:1 agent
// replies. Presenting it as "not receiving mail" would read like a hard block
// and invite a manual removal the operator does not need.
const headline = computed(() => localize(presentation.value.headline));
const detailOpen = ref(false);
</script>

<template>
	<div class="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-sm" role="status">
		<div class="flex items-center gap-2.5">
			<Icon name="lucide:mail-x" class="w-4 h-4 shrink-0 text-warning" />
			<p class="font-medium text-text-primary">
				{{ t('components.contacts.suppressionNotice.title') }}
			</p>
			<UiDisclosure
				v-model="detailOpen"
				controls="suppression-detail"
				:label="t('components.contacts.suppressionNotice.why')"
			>
				<p class="text-text-secondary">
					<I18nT keypath="components.contacts.suppressionNotice.detail" tag="span" scope="global">
						<template #headline>
							<span class="font-medium text-text-primary">{{ headline }}</span>
						</template>
						<template #reason>{{ reasonPhrase }}</template>
					</I18nT>
					<button
						v-if="canManage"
						type="button"
						class="ml-1 font-medium text-brand hover:underline disabled:opacity-60"
						:disabled="removing"
						@click="emit('remove')"
					>
						{{
							removing
								? t('components.contacts.suppressionNotice.removing')
								: t('components.contacts.suppressionNotice.remove')
						}}
					</button>
				</p>
			</UiDisclosure>
		</div>
	</div>
</template>
