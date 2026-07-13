<script setup lang="ts">
import { api } from '@owlat/api';
import { DEFAULT_TRUSTED_ARC_FORWARDERS } from '@owlat/shared/arcTrust';

/**
 * Trusted forwarders editor (Delivery → provider config), Sealed Mail A5.
 *
 * A mailing list or forwarding account re-sends mail from its own servers, which
 * breaks the author's DKIM signature and makes DMARC fail — so a legitimate
 * forwarded message would land in Spam. When a forwarder on THIS list has
 * cryptographically vouched (a valid ARC chain) that the original really did
 * pass, we keep the message in the inbox and mark it "verified via forwarder"
 * instead of failing it.
 *
 * The card writes `instanceSettings.trustedArcForwarders` (admin-gated on the
 * backend). An empty list turns the rescue OFF entirely; leaving it at the
 * seeded defaults is the safe starting point. Human copy only — no ARC/DMARC
 * jargon beyond naming the mechanism plainly.
 */

const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const { data: settings, isLoading } = useConvexQuery(api.workspaces.settings.get, {});

// The effective list: the operator's saved list, or the seeded defaults when
// they have never touched it (unset). An explicit empty array is respected (the
// rescue is off) — distinct from "never set".
const savedList = computed<string[]>(() =>
	settings.value?.trustedArcForwarders != null
		? [...settings.value.trustedArcForwarders]
		: [...DEFAULT_TRUSTED_ARC_FORWARDERS]
);

// Local working copy so edits don't fight the live subscription. Re-seeded from
// the server whenever the saved list changes (initial load or another admin's save).
const draft = ref<string[]>([]);
watch(savedList, (next) => (draft.value = [...next]), { immediate: true });

const newDomain = ref('');

const dirty = computed(
	() =>
		draft.value.length !== savedList.value.length ||
		draft.value.some((d, i) => d !== savedList.value[i])
);

const { run: updateSettings, isLoading: isSaving } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: 'Update trusted forwarders' }
);

function normalize(raw: string): string {
	return raw.trim().toLowerCase().replace(/\.$/, '');
}

function addDomain() {
	if (!canManageOrganization.value) return;
	const domain = normalize(newDomain.value);
	// A bare, dot-bearing domain only — reject blanks, spaces, and single labels
	// so a typo can't silently widen who we trust.
	if (!domain || !domain.includes('.') || /\s/.test(domain)) return;
	if (draft.value.includes(domain)) {
		newDomain.value = '';
		return;
	}
	draft.value = [...draft.value, domain];
	newDomain.value = '';
}

function removeDomain(domain: string) {
	if (!canManageOrganization.value) return;
	draft.value = draft.value.filter((d) => d !== domain);
}

function resetToDefaults() {
	if (!canManageOrganization.value) return;
	draft.value = [...DEFAULT_TRUSTED_ARC_FORWARDERS];
}

async function save() {
	if (!canManageOrganization.value || !dirty.value) return;
	const res = await updateSettings({ trustedArcForwarders: [...draft.value] });
	if (res === undefined) return; // failure already toasted
	showToast(
		draft.value.length === 0
			? 'Trusted forwarders cleared — forwarded mail is no longer rescued.'
			: 'Trusted forwarders saved.'
	);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:forward" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Trusted forwarders</h2>
					<p class="text-sm text-text-secondary">
						Keep mailing-list and forwarded mail out of Spam when the forwarder vouches for it
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-4">
			<div v-if="isLoading" class="flex items-center gap-3 py-2">
				<UiSpinner size="sm" />
				<span class="text-sm text-text-secondary">Loading forwarders…</span>
			</div>

			<template v-else>
				<p class="text-sm text-text-secondary max-w-prose">
					Mailing lists and forwarding services re-send messages from their own servers, which
					normally makes them fail sender checks and land in Spam. A forwarder on this list is one
					you trust to confirm a message really was sent by its original author — those messages
					stay in your inbox and show a "verified via forwarder" note.
				</p>

				<!-- Current list -->
				<ul v-if="draft.length" class="flex flex-wrap gap-2" data-testid="trusted-forwarders-list">
					<li
						v-for="domain in draft"
						:key="domain"
						class="inline-flex items-center gap-1.5 rounded border border-border-subtle px-2 py-1 text-sm text-text-secondary"
					>
						<span>{{ domain }}</span>
						<button
							v-if="canManageOrganization"
							type="button"
							class="text-text-tertiary hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand rounded"
							:aria-label="`Remove ${domain}`"
							@click="removeDomain(domain)"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</li>
				</ul>
				<p v-else class="text-sm text-warning">
					No forwarders are trusted, so forwarded mail is never rescued — it follows the normal
					sender checks.
				</p>

				<!-- Add -->
				<form
					v-if="canManageOrganization"
					class="flex items-center gap-2"
					@submit.prevent="addDomain"
				>
					<UiInput
						v-model="newDomain"
						placeholder="lists.example.com"
						aria-label="Add a trusted forwarder domain"
						class="max-w-xs"
					/>
					<UiButton type="submit" variant="secondary" :disabled="!newDomain.trim()">Add</UiButton>
				</form>

				<div v-if="canManageOrganization" class="flex items-center gap-2 pt-1">
					<UiButton :disabled="!dirty || isSaving" :loading="isSaving" @click="save">Save</UiButton>
					<UiButton variant="ghost" :disabled="isSaving" @click="resetToDefaults">
						Reset to defaults
					</UiButton>
				</div>

				<p v-else class="text-xs text-text-tertiary">Only owners and admins can change this.</p>
			</template>
		</div>
	</UiCard>
</template>
