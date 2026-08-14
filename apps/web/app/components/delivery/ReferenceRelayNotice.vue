<script setup lang="ts">
/**
 * The single-reference-relay warning (plan D8), on the two screens where the
 * consequence is visible: the delivery provider page (where relays are chosen)
 * and the cells page (where the share it freezes is watched).
 *
 * SELF-QUERYING on purpose. The finding belongs to the deployment, not to
 * whatever a page happens to have loaded, and both hosts are already at the
 * file-size cap — a shared component that answers its own question keeps each
 * of them to one tag. The read is the same live `getAlignmentArms` the transport
 * wizard uses, so the two never disagree.
 *
 * Renders NOTHING in every healthy configuration, including the standalone one
 * (`reference.kind === 'none'`): a deployment with no relay is a supported shape
 * (plan D2) and must never see a warning about a second arm it deliberately does
 * not have.
 */
import { api } from '@owlat/api';
import { referenceRelayNotice } from '~/utils/referenceRelay';

const { data: alignmentArms } = useOrganizationQuery(
	api.delivery.alignmentPreflight.getAlignmentArms
);

const notice = computed(() => referenceRelayNotice(alignmentArms.value));

const { t } = useI18n();

/**
 * The notice's own copy lives in `utils/referenceRelay` as i18n keys rather than
 * sentences (the registry convention for module-scope definitions); a plain
 * string is still accepted, which is what the backend's verbatim detail — the
 * sentence naming the relays — stays.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}
</script>

<template>
	<div
		v-if="notice"
		class="card border-warning/30 bg-warning/5 p-5"
		data-testid="reference-relay-notice"
	>
		<div class="flex gap-3">
			<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<div class="min-w-0 space-y-1.5">
				<h3 class="font-medium text-text-primary">{{ localized(notice.title) }}</h3>
				<!-- The backend's own sentence, verbatim: it names the relays. -->
				<p class="text-sm text-text-secondary" data-testid="reference-relay-detail">
					{{ notice.detail }}
				</p>
				<p class="text-sm text-text-secondary">{{ localized(notice.remedy) }}</p>
			</div>
		</div>
	</div>
</template>
