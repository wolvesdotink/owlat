<script setup lang="ts">
/**
 * Per-contact sealing-key panel (Sealed Mail E5, flag `sealedMail`). Shows the
 * PUBLIC trust state Owlat holds for one correspondent — the pinned fingerprint,
 * when it was first seen, where it was discovered, and (on a conflict) the new
 * key awaiting acceptance. Read-only.
 *
 * The trust state is loaded ONCE by the parent (`PostboxThreadSealSurfaces`) and
 * passed down as `status`, so this panel does not re-query the same address.
 * No private material exists in the source shape, so nothing secret is rendered.
 * Re-accepting a changed key happens through PostboxKeyChangeBanner.
 */
import { formatFingerprint } from '~/utils/fingerprints';
import { formatDateTime } from '~/utils/formatters';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';

const props = defineProps<{
	/** The correspondent's address (for the empty-state copy). */
	address: string;
	/** The recipient's PUBLIC key status, loaded once by the parent surfaces. */
	status: RecipientKeyStatus;
}>();

const pinnedFingerprint = computed(() => formatFingerprint(props.status.pinnedFingerprint));
const observedFingerprint = computed(() => formatFingerprint(props.status.observedFingerprint));

const firstSeen = computed(() => {
	const at = props.status.discoveredAt;
	return at ? formatDateTime(at) : null;
});

const sourceLabel = computed(() => {
	switch (props.status.source) {
		case 'manifest':
			return 'the sending server';
		case 'wkd':
			return 'their domain (Web Key Directory)';
		default:
			return null;
	}
});
</script>

<template>
	<section class="rounded border border-border-subtle p-3" data-testid="contact-key-panel">
		<h3 class="text-sm font-medium text-text-primary">Sealing key</h3>

		<p
			v-if="status.outcome === 'notFound'"
			class="mt-2 text-xs text-text-secondary"
			data-testid="contact-key-empty"
		>
			Owlat hasn't found a sealing key for {{ address }} yet, so mail to them is sent normally.
		</p>

		<div v-else class="mt-2 space-y-1.5 text-xs">
			<div class="flex items-center gap-1.5">
				<Icon
					:name="status.outcome === 'trusted' ? 'lucide:lock' : 'lucide:key-round'"
					class="w-3.5 h-3.5"
					:class="status.outcome === 'trusted' ? 'text-success' : 'text-warning'"
				/>
				<span
					:class="status.outcome === 'trusted' ? 'text-text-secondary' : 'text-warning'"
					data-testid="contact-key-state"
				>
					{{ status.outcome === 'trusted' ? 'Trusted key pinned' : 'Key changed — needs review' }}
				</span>
			</div>

			<dl class="space-y-1 text-text-tertiary">
				<div v-if="pinnedFingerprint" class="flex gap-2">
					<dt class="w-24 flex-shrink-0">Fingerprint</dt>
					<dd class="font-mono text-text-secondary break-all">{{ pinnedFingerprint }}</dd>
				</div>
				<div v-if="firstSeen" class="flex gap-2">
					<dt class="w-24 flex-shrink-0">First seen</dt>
					<dd>{{ firstSeen }}</dd>
				</div>
				<div v-if="sourceLabel" class="flex gap-2">
					<dt class="w-24 flex-shrink-0">Found via</dt>
					<dd>{{ sourceLabel }}</dd>
				</div>
				<div
					v-if="status.outcome === 'keyChanged' && observedFingerprint"
					class="flex gap-2"
					data-testid="contact-key-new"
				>
					<dt class="w-24 flex-shrink-0 text-warning">New key</dt>
					<dd class="font-mono text-warning break-all">{{ observedFingerprint }}</dd>
				</div>
			</dl>
		</div>
	</section>
</template>
