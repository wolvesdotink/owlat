<script setup lang="ts">
/**
 * "Import from website": read a site's colours, logo and name, show the
 * proposal, and hand what the admin keeps to the brand kit form. Nothing is
 * saved here; a chosen logo goes into the media library when the admin
 * applies the proposal, and the kit itself is saved from the page.
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { BrandLogoAsset } from '@owlat/shared/brandKitBlocks';

type ImportResult = FunctionReturnType<typeof api.workspaces.brandKitImport.importFromWebsite>;
type Proposal = Extract<ImportResult, { ok: true }>['value'];

export interface BrandKitImportSelection {
	colors: Partial<
		Record<
			'primaryColor' | 'secondaryColor' | 'textColor' | 'backgroundColor' | 'linkColor',
			string
		>
	> & { swatches?: string[] };
	companyName?: string;
	logo?: BrandLogoAsset;
}

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ apply: [selection: BrandKitImportSelection] }>();
const { t } = useI18n();

const url = ref('');
const proposal = ref<Proposal | null>(null);
const useColors = ref(true);
const useName = ref(true);
const chosenLogo = ref<string>('');
const error = ref<string | null>(null);

const importOp = useBackendOperation(api.workspaces.brandKitImport.importFromWebsite, {
	label: () => t('dashboard.admin.instance.brandKit.import.fetchOperation'),
	inlineTarget: error,
});
const logoOp = useBackendOperation(api.workspaces.brandKitImport.importLogo, {
	label: () => t('dashboard.admin.instance.brandKit.import.logoOperation'),
	inlineTarget: error,
});

const COLOR_KEYS = [
	['primaryColor', 'primary'],
	['secondaryColor', 'secondary'],
	['textColor', 'text'],
	['backgroundColor', 'background'],
	['linkColor', 'link'],
] as const;

const proposedColors = computed(() =>
	proposal.value
		? COLOR_KEYS.flatMap(([key, label]) => {
				const value = proposal.value![key];
				return value ? [{ key, label, value }] : [];
			})
		: []
);
const hasColors = computed(
	() => proposedColors.value.length > 0 || (proposal.value?.swatches.length ?? 0) > 0
);

watch(open, (isOpen) => {
	if (!isOpen) return;
	proposal.value = null;
	error.value = null;
	chosenLogo.value = '';
});

const errorText = (code: string) => t(`dashboard.admin.instance.brandKit.import.errors.${code}`);

async function fetchProposal() {
	error.value = null;
	const result = await importOp.run({ url: url.value });
	if (!result.ok) return;
	if (!result.result.ok) {
		error.value = errorText(result.result.error);
		return;
	}
	proposal.value = result.result.value;
	useColors.value = true;
	useName.value = Boolean(result.result.value.companyName);
	chosenLogo.value = result.result.value.logoCandidates[0]?.url ?? '';
}

async function apply() {
	const p = proposal.value;
	if (!p) return;
	error.value = null;
	const selection: BrandKitImportSelection = { colors: {} };
	if (useColors.value) {
		for (const { key, value } of proposedColors.value) selection.colors[key] = value;
		if (p.swatches.length > 0) selection.colors.swatches = p.swatches;
	}
	if (useName.value && p.companyName) selection.companyName = p.companyName;
	if (chosenLogo.value) {
		const result = await logoOp.run({ url: chosenLogo.value });
		if (!result.ok) return;
		if (!result.result.ok) {
			error.value = errorText(result.result.error);
			return;
		}
		selection.logo = {
			url: result.result.value.url,
			storageId: result.result.value.storageId,
			mediaAssetId: result.result.value.mediaAssetId,
		};
	}
	emit('apply', selection);
	open.value = false;
}
</script>

<template>
	<UiModal
		:open="open"
		:title="t('dashboard.admin.instance.brandKit.import.title')"
		size="lg"
		@update:open="open = $event"
	>
		<form v-if="!proposal" class="space-y-4" @submit.prevent="fetchProposal">
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.admin.instance.brandKit.import.description') }}
			</p>
			<UiInput
				id="brand-kit-import-url"
				v-model="url"
				:label="t('dashboard.admin.instance.brandKit.import.urlLabel')"
				:placeholder="t('dashboard.admin.instance.brandKit.import.urlPlaceholder')"
				:error="error ?? undefined"
				autocomplete="url"
				autofocus
			/>
		</form>

		<div v-else class="space-y-6" data-testid="brand-kit-import-proposal">
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.admin.instance.brandKit.import.proposalHint', { url: proposal.url }) }}
			</p>

			<section>
				<UiCheckbox
					v-if="hasColors"
					v-model="useColors"
					:label="t('dashboard.admin.instance.brandKit.import.useColors')"
				/>
				<p v-else class="text-sm text-text-tertiary">
					{{ t('dashboard.admin.instance.brandKit.import.noColors') }}
				</p>
				<ul v-if="hasColors" class="mt-3 flex flex-wrap gap-3">
					<li v-for="color in proposedColors" :key="color.key" class="flex items-center gap-2">
						<span
							class="w-7 h-7 rounded-md border border-border-subtle"
							:style="{ backgroundColor: color.value }"
						/>
						<span class="text-xs">
							<span class="block text-text-primary">
								{{ t(`dashboard.admin.instance.brandKit.colors.${color.label}`) }}
							</span>
							<span class="font-mono text-text-tertiary">{{ color.value }}</span>
						</span>
					</li>
					<li v-for="swatch in proposal.swatches" :key="swatch" class="flex items-center gap-2">
						<span
							class="w-7 h-7 rounded-md border border-border-subtle"
							:style="{ backgroundColor: swatch }"
						/>
						<span class="text-xs font-mono text-text-tertiary">{{ swatch }}</span>
					</li>
				</ul>
			</section>

			<section v-if="proposal.companyName">
				<UiCheckbox
					v-model="useName"
					:label="
						t('dashboard.admin.instance.brandKit.import.useName', { name: proposal.companyName })
					"
				/>
			</section>

			<section>
				<p class="label">{{ t('dashboard.admin.instance.brandKit.logo.title') }}</p>
				<p v-if="proposal.logoCandidates.length === 0" class="text-sm text-text-tertiary">
					{{ t('dashboard.admin.instance.brandKit.import.noCandidates') }}
				</p>
				<div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-3" role="radiogroup">
					<label
						v-for="candidate in proposal.logoCandidates"
						:key="candidate.url"
						class="flex flex-col gap-2 rounded-lg border p-2 cursor-pointer"
						:class="
							chosenLogo === candidate.url
								? 'border-brand ring-1 ring-brand'
								: 'border-border-subtle'
						"
					>
						<input v-model="chosenLogo" type="radio" :value="candidate.url" class="sr-only" />
						<span class="h-16 flex items-center justify-center bg-white rounded">
							<img
								:src="candidate.url"
								alt=""
								referrerpolicy="no-referrer"
								class="max-h-14 max-w-full object-contain"
							/>
						</span>
						<span class="text-xs text-text-secondary">
							{{ t(`dashboard.admin.instance.brandKit.import.sources.${candidate.source}`) }}
						</span>
					</label>
					<label
						class="flex items-center justify-center rounded-lg border p-2 cursor-pointer text-xs text-text-secondary text-center"
						:class="chosenLogo === '' ? 'border-brand ring-1 ring-brand' : 'border-border-subtle'"
					>
						<input v-model="chosenLogo" type="radio" value="" class="sr-only" />
						{{ t('dashboard.admin.instance.brandKit.import.noLogo') }}
					</label>
				</div>
			</section>

			<p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
		</div>

		<template #footer>
			<div class="flex justify-end gap-3">
				<UiButton
					v-if="proposal"
					variant="ghost"
					type="button"
					:disabled="logoOp.isLoading.value"
					@click="proposal = null"
				>
					{{ t('dashboard.admin.instance.brandKit.import.back') }}
				</UiButton>
				<UiButton v-else variant="ghost" type="button" @click="open = false">
					{{ t('dashboard.admin.instance.brandKit.import.cancel') }}
				</UiButton>
				<UiButton
					v-if="!proposal"
					type="button"
					:disabled="!url.trim() || importOp.isLoading.value"
					@click="fetchProposal"
				>
					{{
						importOp.isLoading.value
							? t('dashboard.admin.instance.brandKit.import.fetching')
							: t('dashboard.admin.instance.brandKit.import.fetch')
					}}
				</UiButton>
				<UiButton
					v-else
					type="button"
					:disabled="logoOp.isLoading.value || (!useColors && !useName && !chosenLogo)"
					data-testid="brand-kit-import-apply"
					@click="apply"
				>
					{{
						logoOp.isLoading.value
							? t('dashboard.admin.instance.brandKit.import.applying')
							: t('dashboard.admin.instance.brandKit.import.apply')
					}}
				</UiButton>
			</div>
		</template>
	</UiModal>
</template>
