<script setup lang="ts">
/**
 * The feature picker shared by Settings → Features and the setup wizard's
 * features step.
 *
 * The three packs (Email client, Marketing, AI) are the main controls; each
 * pack's individual flags sit behind its own "Customize" disclosure, and flags
 * that belong to no pack share a switchless "More features" group. Flag keys,
 * Docker profiles and env names stay one click away in each flag's collapsed
 * "Technical details" (FeatureFlagMetadata) — self-hosters need them, the
 * switch label doesn't.
 *
 * Presentational: the parent owns persistence (a Convex write on the settings
 * page, wizard state in setup) and reacts to `toggle-pack` / `toggle-flag`.
 * Customize panels use `v-show`, so every switch stays in the DOM (and
 * addressable by its `feature-switch-<key>` test id) while collapsed.
 */
import {
	isPackEnabled,
	type FeatureFlagDefinition,
	type FeatureFlagKey,
	type FeatureFlagRegistry,
	type FeatureFlagState,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { useId } from 'vue';
import FeatureFlagMetadata from '~/components/settings/FeatureFlagMetadata.vue';
import FeatureToggleSwitch from '~/components/settings/FeatureToggleSwitch.vue';
import { useFeatureCopy } from '~/composables/useFeatureCopy';
import { groupFeatureFlags, type FeatureGroup, type FeatureGroupKey } from '~/utils/featureGroups';

const props = withDefaults(
	defineProps<{
		registry: FeatureFlagRegistry;
		/** Stored flag overrides — what pack state is computed from. */
		stored: FeatureFlagState;
		/** Resolved (dependency-applied) flag values. */
		resolved: Readonly<Record<string, boolean>>;
		/** Disable every flag switch (a write is in flight). */
		flagsBusy?: boolean;
		/** Disable every pack switch (a write is in flight). */
		packsBusy?: boolean;
		/**
		 * An extra, caller-specific reason a flag can't be switched right now
		 * (e.g. plugin configuration still loading). Dependency reasons are
		 * computed here.
		 */
		flagBlockedReason?: (def: FeatureFlagDefinition) => string | undefined;
		/** Flags that are on but still missing configuration. */
		needsConfig?: ReadonlySet<string>;
		/** What each flag is missing, for the "Needs setup" badge's tooltip. */
		missingConfig?: Readonly<Record<string, readonly string[]>> | null;
		/** Groups whose Customize panel starts open. */
		initiallyOpen?: readonly FeatureGroupKey[];
	}>(),
	{
		flagsBusy: false,
		packsBusy: false,
		flagBlockedReason: undefined,
		needsConfig: () => new Set<string>(),
		missingConfig: null,
		initiallyOpen: () => [],
	}
);

const emit = defineEmits<{
	'toggle-pack': [pack: FeaturePackKey];
	'toggle-flag': [flag: FeatureFlagKey, value: boolean];
}>();

defineSlots<{
	/** Rendered under a pack's description, visible whether or not it is expanded. */
	'pack-note'?: (props: { group: FeatureGroup }) => unknown;
	/** Rendered at the top of a group's expanded Customize panel. */
	'group-notice'?: (props: { group: FeatureGroup }) => unknown;
}>();

const { t } = useI18n();
const { flagLabel, flagKeyLabel, flagDescription, packLabel, packDescription } = useFeatureCopy();

const groups = computed(() => groupFeatureFlags(props.registry));

const open = ref<Set<FeatureGroupKey>>(new Set(props.initiallyOpen));
function toggleOpen(key: FeatureGroupKey) {
	const next = new Set(open.value);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	open.value = next;
}

const panelIdBase = useId();
const panelId = (key: FeatureGroupKey) => `${panelIdBase}-${key}`;

function packState(group: FeatureGroup): 'on' | 'off' | 'partial' {
	return group.pack ? isPackEnabled(props.stored, group.pack) : 'off';
}

function groupLabel(group: FeatureGroup): string {
	return group.pack ? packLabel(group.pack) : t('components.settings.featurePackList.more.label');
}

function groupDescription(group: FeatureGroup): string {
	return group.pack
		? packDescription(group.pack)
		: t('components.settings.featurePackList.more.description');
}

function groupNeedsConfig(group: FeatureGroup): boolean {
	return group.flags.some((def) => props.needsConfig.has(def.key));
}

function onCount(group: FeatureGroup): number {
	return group.flags.filter((def) => props.resolved[def.key]).length;
}

/**
 * Why a flag's switch is dependency-blocked, or `undefined` when it isn't. All
 * `requires` parents must be on; each `requiresAny` group needs at least one on
 * member. Turning a flag on never auto-enables an any-of member (there is no
 * principled pick), so the switch stays disabled with this hint instead.
 */
function dependencyReason(def: FeatureFlagDefinition): string | undefined {
	const missing = (def.requires ?? []).filter((dep) => !props.resolved[dep]);
	if (missing.length > 0) {
		return t('components.settings.featurePackList.enableFirst', {
			flags: missing.map((k) => flagKeyLabel(k, props.registry[k])).join(', '),
		});
	}
	const unsatisfied = (def.requiresAny ?? []).filter(
		(group) => !group.some((member) => props.resolved[member])
	);
	if (unsatisfied.length === 0) return undefined;
	return unsatisfied
		.map((group) =>
			t('components.settings.featurePackList.needsOneOf', {
				flags: group.map((k) => flagKeyLabel(k, props.registry[k])).join(', '),
			})
		)
		.join(' · ');
}

function blockedReason(def: FeatureFlagDefinition): string | undefined {
	return dependencyReason(def) ?? props.flagBlockedReason?.(def);
}
</script>

<template>
	<div class="space-y-4">
		<UiCard v-for="group in groups" :key="group.key" padding="none" overflow="hidden">
			<div
				class="px-6 py-4 flex items-start justify-between gap-4"
				:data-testid="`feature-group-${group.key}`"
			>
				<div class="min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<h2 class="font-medium text-text-primary">{{ groupLabel(group) }}</h2>
						<span
							v-if="packState(group) === 'partial'"
							class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary"
						>
							{{ t('components.settings.featurePackList.partial') }}
						</span>
						<span
							v-if="groupNeedsConfig(group)"
							class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning"
						>
							<Icon name="lucide:alert-triangle" class="w-3 h-3" />
							{{ t('components.settings.featurePackList.needsSetup') }}
						</span>
					</div>
					<p class="text-sm text-text-secondary mt-0.5">{{ groupDescription(group) }}</p>
					<slot name="pack-note" :group="group" />
					<button
						type="button"
						class="mt-2 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-expanded="open.has(group.key)"
						:aria-controls="panelId(group.key)"
						:data-testid="`feature-customize-${group.key}`"
						@click="toggleOpen(group.key)"
					>
						<Icon
							:name="open.has(group.key) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
							class="w-4 h-4"
						/>
						{{
							t('components.settings.featurePackList.customize', {
								on: onCount(group),
								total: group.flags.length,
							})
						}}
					</button>
				</div>
				<FeatureToggleSwitch
					v-if="group.pack"
					:state="packState(group)"
					:label="groupLabel(group)"
					:disabled="packsBusy"
					@toggle="group.pack && emit('toggle-pack', group.pack)"
				/>
			</div>

			<div
				v-show="open.has(group.key)"
				:id="panelId(group.key)"
				class="border-t border-border-subtle bg-bg-surface/40"
			>
				<slot name="group-notice" :group="group" />
				<ul class="divide-y divide-border-subtle">
					<li
						v-for="def in group.flags"
						:key="def.key"
						class="px-6 py-3 flex items-start justify-between gap-4"
					>
						<div class="min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<p class="text-sm font-medium text-text-primary">{{ flagLabel(def) }}</p>
								<span
									v-if="needsConfig.has(def.key)"
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning"
									:title="
										t('components.settings.featurePackList.needsSetupTitle', {
											missing: (missingConfig?.[def.key] ?? []).join(', '),
										})
									"
								>
									<Icon name="lucide:alert-triangle" class="w-3 h-3" />
									{{ t('components.settings.featurePackList.needsSetup') }}
								</span>
							</div>
							<p class="text-sm text-text-secondary mt-0.5">{{ flagDescription(def) }}</p>
							<p v-if="dependencyReason(def)" class="text-xs text-text-tertiary mt-1">
								{{ dependencyReason(def) }}
							</p>
							<FeatureFlagMetadata :definition="def" />
						</div>
						<FeatureToggleSwitch
							:state="resolved[def.key] ? 'on' : 'off'"
							:label="flagLabel(def)"
							:data-testid="`feature-switch-${def.key}`"
							:disabled="flagsBusy || blockedReason(def) !== undefined"
							:title="blockedReason(def)"
							@toggle="emit('toggle-flag', def.key, !resolved[def.key])"
						/>
					</li>
				</ul>
			</div>
		</UiCard>
	</div>
</template>
