<script setup lang="ts">
/**
 * Delivery provider → per-IP EHLO names, for a server that sends from several
 * IP addresses whose reverse-DNS names differ.
 *
 * `EHLO_HOSTNAME` covers the usual single-IP server. Only when the sending IPs
 * resolve to different names does the MTA need `EHLO_HOSTNAMES`, a JSON map from
 * IP to hostname. The operator fills in a small table; the card hands over the
 * `.env` line and `owlat env` command through the shared EnvSetupSteps block,
 * validated by the same parser the MTA uses. The server does not report the
 * value back, so the block does not wait for a connection.
 */
import {
	EHLO_ROW_PROBLEM_KEYS,
	ehloHostnamesValue,
	ehloRowProblem,
	type EhloOverrideRow,
} from '~/utils/ehloOverrides';

const { t } = useI18n();

const rows = ref<EhloOverrideRow[]>([{ ip: '', hostname: '' }]);
const value = computed(() => ehloHostnamesValue(rows.value));

function rowError(row: EhloOverrideRow): string | undefined {
	const problem = ehloRowProblem(row);
	return problem ? t(EHLO_ROW_PROBLEM_KEYS[problem]) : undefined;
}

function addRow() {
	rows.value.push({ ip: '', hostname: '' });
}

function removeRow(index: number) {
	rows.value.splice(index, 1);
	if (rows.value.length === 0) addRow();
}
</script>

<template>
	<UiCard padding="none" overflow="hidden" data-testid="ehlo-overrides">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:network" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('components.delivery.ehloOverrides.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.delivery.ehloOverrides.subtitle') }}
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-4">
			<div
				v-for="(row, index) in rows"
				:key="index"
				class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start"
				data-testid="ehlo-override-row"
			>
				<UiInput
					v-model="row.ip"
					:label="t('components.delivery.ehloOverrides.ipLabel')"
					placeholder="203.0.113.11"
					:error="ehloRowProblem(row) === 'ip' ? rowError(row) : undefined"
				/>
				<UiInput
					v-model="row.hostname"
					:label="t('components.delivery.ehloOverrides.hostnameLabel')"
					placeholder="mail2.example.com"
					:error="ehloRowProblem(row) === 'hostname' ? rowError(row) : undefined"
				/>
				<UiButton
					variant="ghost"
					size="sm"
					class="sm:mt-6"
					:aria-label="t('components.delivery.ehloOverrides.removeRow', { index: index + 1 })"
					@click="removeRow(index)"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</UiButton>
			</div>

			<UiButton variant="secondary" size="sm" data-testid="ehlo-override-add" @click="addRow">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.delivery.ehloOverrides.addRow') }}
			</UiButton>

			<DeliveryEnvSetupSteps
				v-if="value"
				:variables="['EHLO_HOSTNAMES']"
				:values="{ EHLO_HOSTNAMES: value }"
				:connected="false"
				:await-connection="false"
			/>
		</div>
	</UiCard>
</template>
