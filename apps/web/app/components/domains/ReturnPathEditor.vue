<script setup lang="ts">
/**
 * Return-path (bounce) host editor for an expanded domain row (piece D3).
 *
 * Extracted from RecordRow.vue: the row was already near the ~500-LOC cap, and
 * the editor is a self-contained widget (its own toggle, input, validation and
 * mutation), so per CONVENTIONS.md it lives in its own file rather than being
 * baselined.
 *
 * Changing the return-path host re-verifies the domain (the backend drops it to
 * `pending` and regenerates the MAIL FROM SPF record), so the edit affordance
 * states that plainly before the user commits. Writes go through the D2 mutation
 * `api.domains.returnPath.setReturnPathHost`; the reflect-to-MTA step can fail
 * permanently and — only after D2's bounded retry budget is spent — leaves a
 * terminal `returnPathHostSyncError` marker on the domain, which we surface as a
 * "couldn't update the bounce host — edit and retry" call to action.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isDnsLabel } from '@owlat/shared';
import { useFormValidation, type ValidationRule } from '~/composables/useFormValidation';

const props = defineProps<{
	domainId: Id<'domains'>;
	/** The current return-path host, e.g. `bounce.example.com`, or null if unset. */
	currentHost: string | null;
	/** The registrable zone the return-path host is composed under. */
	zone: string;
	/** Marker set by the backend when reflecting the host to the MTA failed. */
	syncError?: string | null;
	/** Whether the current member may change domain settings. */
	canManage: boolean;
}>();

const { t } = useI18n();

const { run: setReturnPathHost, isLoading: isSaving } = useBackendOperation(
	api.domains.returnPath.setReturnPathHost,
	{ label: () => t('components.domains.returnPathEditor.saveOperation') }
);

const editing = ref(false);
const sub = ref('');
const normalizedSub = computed(() => sub.value.trim().toLowerCase());

// The absolute host the label composes to (a sibling of the sending name).
const composedHost = computed(() =>
	normalizedSub.value ? `${normalizedSub.value}.${props.zone}` : ''
);

const rule: ValidationRule = (value) => {
	const raw = String(value ?? '').trim();
	if (!raw) return t('components.domains.returnPathEditor.errors.required');
	return (
		isDnsLabel(raw.toLowerCase()) || t('components.domains.returnPathEditor.errors.invalidLabel')
	);
};
const validation = useFormValidation({ returnPath: [rule] });
const error = computed(() => validation.getError('returnPath'));
const showPreview = computed(() => !validation.hasError('returnPath'));
const describedBy = computed(() => {
	if (error.value) return `returnpath-error-${props.domainId}`;
	return showPreview.value ? `returnpath-preview-${props.domainId}` : undefined;
});

// Seed the input from the current host relative to the zone (so editing
// `bounce.example.com` in zone `example.com` starts at `bounce`); fall back to
// the recommended `bounce` when there is nothing in-zone to seed from.
function startEditing() {
	const suffix = `.${props.zone}`;
	if (props.currentHost && props.currentHost.endsWith(suffix)) {
		sub.value = props.currentHost.slice(0, props.currentHost.length - suffix.length);
	} else {
		sub.value = 'bounce';
	}
	validation.reset();
	editing.value = true;
}

function cancel() {
	editing.value = false;
}

function handleBlur() {
	validation.touch('returnPath');
	validation.validateField('returnPath', sub.value);
}

async function save() {
	validation.touch('returnPath');
	if (!validation.validate({ returnPath: sub.value })) return;
	// `run` resolves to the mutation's return (null for a void mutation) on
	// success and `undefined` when the operation layer caught + surfaced a
	// failure — so only collapse on a non-undefined result.
	const result = await setReturnPathHost({
		domainId: props.domainId,
		returnPathHost: composedHost.value,
	});
	if (result === undefined) return;
	editing.value = false;
}
</script>

<template>
	<div class="pt-2" data-testid="returnpath-editor">
		<div class="flex items-center justify-between gap-3">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				{{ t('components.domains.returnPathEditor.heading') }}
			</p>
			<UiButton
				variant="ghost"
				v-if="canManage && !editing"
				type="button"
				class="text-xs py-1 px-2 gap-1.5"
				data-testid="returnpath-edit"
				@click="startEditing"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
				{{ t('common.edit') }}
			</UiButton>
		</div>

		<!-- Collapsed: show the current host + a sync-error marker if reflecting it
		     to the MTA failed. -->
		<template v-if="!editing">
			<I18nT
				keypath="components.domains.returnPathEditor.currentHost"
				tag="p"
				scope="global"
				class="mt-1 text-sm text-text-secondary"
			>
				<template #host>
					<strong class="text-text-primary">
						{{ currentHost ?? t('components.domains.returnPathEditor.defaultHost') }}
					</strong>
				</template>
			</I18nT>
			<!-- Informational only. The return-path host is optional and stays
			     optional: this sentence exists because a per-domain host is also what
			     enables RFC 9477 complaint feedback, which is otherwise invisible from
			     the product. It is never a warning, a checklist item or a "setup
			     incomplete" state. -->
			<I18nT
				keypath="components.domains.returnPathEditor.cfblNote"
				tag="p"
				scope="global"
				class="mt-1 text-xs text-text-tertiary"
				data-testid="returnpath-cfbl-note"
			>
				<template #header>
					<code>CFBL-Address</code>
				</template>
			</I18nT>
			<!-- Terminal marker: D2 sets `returnPathHostSyncError` only AFTER its
			     bounded retry budget is exhausted, so this is a give-up the user must
			     act on — not an in-progress retry. No spinner. -->
			<p
				v-if="syncError"
				class="mt-1 inline-flex items-start gap-1.5 text-xs text-error"
				data-testid="returnpath-sync-error"
			>
				<Icon name="lucide:alert-triangle" class="w-3 h-3 mt-0.5 shrink-0" />
				<span>{{ t('components.domains.returnPathEditor.syncError') }}</span>
			</p>
		</template>

		<!-- Editing: label input + live preview + the re-verify warning. -->
		<div v-else class="mt-2">
			<label :for="`returnpath-input-${domainId}`" class="sr-only">
				{{ t('components.domains.returnPathEditor.inputLabel') }}
			</label>
			<div class="flex items-center gap-2">
				<input
					:id="`returnpath-input-${domainId}`"
					v-model="sub"
					type="text"
					:placeholder="t('components.domains.returnPathEditor.inputPlaceholder')"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					class="input flex-1"
					:class="error && 'input-error'"
					:disabled="isSaving"
					:aria-invalid="error ? 'true' : undefined"
					:aria-describedby="describedBy"
					@blur="handleBlur"
				/>
				<UiButton
					type="button"
					class="text-sm py-1.5 px-3 gap-1.5"
					data-testid="returnpath-save"
					:disabled="isSaving"
					@click="save"
				>
					<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					{{ isSaving ? t('common.saving') : t('common.save') }}
				</UiButton>
				<UiButton
					variant="secondary"
					type="button"
					class="text-sm py-1.5 px-3"
					:disabled="isSaving"
					@click="cancel"
				>
					{{ t('common.cancel') }}
				</UiButton>
			</div>

			<p
				v-if="error"
				:id="`returnpath-error-${domainId}`"
				class="mt-1 text-xs text-error"
				data-testid="returnpath-edit-error"
			>
				{{ error }}
			</p>
			<p
				v-if="showPreview"
				:id="`returnpath-preview-${domainId}`"
				class="mt-1 text-xs text-text-secondary"
				data-testid="returnpath-edit-preview"
			>
				<I18nT
					v-if="normalizedSub"
					keypath="components.domains.returnPathEditor.preview"
					tag="span"
					scope="global"
				>
					<template #host>
						<strong class="text-text-primary">{{ normalizedSub }}.{{ zone }}</strong>
					</template>
				</I18nT>
				<I18nT
					v-else
					keypath="components.domains.returnPathEditor.previewExample"
					tag="span"
					scope="global"
				>
					<template #host>
						<span class="font-medium text-text-primary">bounce.{{ zone }}</span>
					</template>
				</I18nT>
			</p>

			<p
				class="mt-2 inline-flex items-start gap-1.5 text-xs text-warning"
				data-testid="returnpath-reverify-warning"
			>
				<Icon name="lucide:alert-triangle" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
				<span>{{ t('components.domains.returnPathEditor.reverifyWarning') }}</span>
			</p>
		</div>
	</div>
</template>
