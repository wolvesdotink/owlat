<script setup lang="ts">
/**
 * The provider list inside the routing editor: which transports a message type
 * may use, in what ORDER, and — for a split — with what weight.
 *
 * The order is the meaning, not decoration: `priority_failover` tries the list
 * top-down, so the reorder buttons are the control that decides which transport
 * a message reaches first. The list is edited in place (the entries are the same
 * objects the page writes back), and the page keeps ownership of the save rule —
 * this component only refuses to render a state it cannot represent.
 *
 * A transport the catalog no longer offers stays VISIBLE and is marked
 * unavailable rather than disappearing: it is still on the persisted route, and
 * an operator who cannot see it cannot decide to remove it.
 *
 * A transport that is registered but NOT CONNECTED (its credentials are not on
 * the server) offers its setup in place: the `.env` lines and `owlat` commands
 * for the variables it needs, and it flips to "Connected" — and becomes
 * selectable — once the server reports it ready.
 */
import DeliveryEnvSetupSteps from './EnvSetupSteps.vue';

interface ProviderEntry {
	providerType: string;
	weight?: number;
	isEnabled: boolean;
}

const props = defineProps<{
	/** The route's strategy — decides whether weights are part of the answer. */
	strategy: string;
	/** The operator's name for a transport kind (localized by the page). */
	providerLabel: (providerType: string) => string;
	/** Whether the transport can send right now (registered and configured). */
	providerAvailable: (providerType: string) => boolean;
	/**
	 * The variables the server needs before that transport can send; empty for a
	 * retired kind, which has no setup to offer.
	 */
	setupVariables?: (providerType: string) => readonly string[];
}>();

const emit = defineEmits<{ refresh: [] }>();

/** Transports whose setup block is open. Kept open after they connect, to say so. */
const openSetup = ref(new Set<string>());
function toggleSetup(providerType: string) {
	const next = new Set(openSetup.value);
	if (next.has(providerType)) next.delete(providerType);
	else next.add(providerType);
	openSetup.value = next;
}
function variablesFor(providerType: string): readonly string[] {
	return props.setupVariables?.(providerType) ?? [];
}

const providers = defineModel<ProviderEntry[]>({ required: true });

const { t } = useI18n();

const enabledProviderCount = computed(() => providers.value.filter((p) => p.isEnabled).length);

function moveProvider(index: number, direction: -1 | 1) {
	const target = index + direction;
	if (target < 0 || target >= providers.value.length) return;
	const next = [...providers.value];
	const [moved] = next.splice(index, 1);
	if (!moved) return;
	next.splice(target, 0, moved);
	providers.value = next;
}
</script>

<template>
	<div>
		<div class="flex items-center justify-between mb-2">
			<span class="label mb-0">{{
				t('dashboard.admin.delivery.providerRouting.editModal.providers')
			}}</span>
			<span class="text-xs text-text-tertiary">
				{{
					props.strategy === 'priority_failover'
						? t('dashboard.admin.delivery.providerRouting.editModal.failoverOrder')
						: ''
				}}
			</span>
		</div>
		<div class="space-y-2">
			<div
				v-for="(provider, index) in providers"
				:key="provider.providerType"
				class="rounded-lg border border-border-subtle bg-bg-surface/40"
			>
				<div class="flex items-center gap-3 p-3">
					<!-- Reorder -->
					<div class="flex flex-col">
						<button
							type="button"
							class="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
							:disabled="index === 0"
							:title="t('dashboard.admin.delivery.providerRouting.editModal.moveUp')"
							@click="moveProvider(index, -1)"
						>
							<Icon name="lucide:chevron-up" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
							:disabled="index === providers.length - 1"
							:title="t('dashboard.admin.delivery.providerRouting.editModal.moveDown')"
							@click="moveProvider(index, 1)"
						>
							<Icon name="lucide:chevron-down" class="w-4 h-4" />
						</button>
					</div>

					<!-- Enabled toggle + name -->
					<label class="flex items-center gap-2 flex-1 cursor-pointer">
						<input
							v-model="provider.isEnabled"
							type="checkbox"
							class="rounded border-border-subtle text-brand focus:ring-brand"
							:disabled="!props.providerAvailable(provider.providerType)"
						/>
						<span class="text-sm font-medium text-text-primary">
							{{ props.providerLabel(provider.providerType) }}
						</span>
						<span
							v-if="!props.providerAvailable(provider.providerType)"
							class="text-xs text-warning"
						>
							{{ t('dashboard.admin.delivery.providerRouting.editModal.unavailable') }}
						</span>
					</label>

					<button
						v-if="
							variablesFor(provider.providerType).length > 0 &&
							(!props.providerAvailable(provider.providerType) ||
								openSetup.has(provider.providerType))
						"
						type="button"
						class="text-xs text-brand hover:underline"
						:aria-expanded="openSetup.has(provider.providerType)"
						:data-testid="`route-provider-setup-${provider.providerType}`"
						@click="toggleSetup(provider.providerType)"
					>
						{{
							openSetup.has(provider.providerType)
								? t('dashboard.admin.delivery.providerRouting.editModal.hideSetup')
								: t('dashboard.admin.delivery.providerRouting.editModal.showSetup')
						}}
					</button>

					<!-- Weight (workload_split only) -->
					<div v-if="props.strategy === 'workload_split'" class="flex items-center gap-1.5">
						<input
							v-model.number="provider.weight"
							type="number"
							min="0"
							max="100"
							class="input w-20 text-sm"
							:disabled="!provider.isEnabled"
						/>
						<span class="text-xs text-text-tertiary">{{
							t('dashboard.admin.delivery.providerRouting.editModal.weightUnit')
						}}</span>
					</div>
				</div>
				<DeliveryEnvSetupSteps
					v-if="openSetup.has(provider.providerType)"
					class="border-t border-border-subtle px-3 pb-3 pt-3"
					:variables="variablesFor(provider.providerType)"
					:connected="props.providerAvailable(provider.providerType)"
					@refresh="emit('refresh')"
				/>
			</div>
		</div>
		<p v-if="enabledProviderCount === 0" class="mt-2 text-xs text-error">
			{{ t('dashboard.admin.delivery.providerRouting.editModal.enableOne') }}
		</p>
	</div>
</template>
