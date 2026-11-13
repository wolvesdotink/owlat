<script setup lang="ts">
/**
 * Why this campaign cannot go out, with a link to the page that fixes it.
 *
 * Shown in two places with one look: before the click, from what the editor
 * and the review step can see (`presendBlocker`), and after a refused send or
 * schedule (`blockerFromRefusal`). Every fix page is admin-only
 * (`middleware/admin.ts`), so a member gets the sentence and "ask an admin"
 * instead of a link that would bounce them to Home.
 *
 * The live region is the caller's choice: `status` for a note that appears
 * while the operator edits the sender or audience, `alert` for a refusal that
 * answers the click.
 */
import type { SendBlocker } from '~/lib/campaignRefusal';
import { useLocalized } from '~/composables/useLocalized';
import { CircleWarningIcon } from '@coolicons/vue';

defineProps<{ blocker: SendBlocker }>();

const { t } = useI18n();
const localized = useLocalized();
const { isAdmin } = usePermissions();
</script>

<template>
	<div
		class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
		data-testid="send-blocked-note"
	>
		<CircleWarningIcon class="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="text-text-primary">
				{{ localized(blocker.message) }}
			</p>
			<NuxtLink
				v-if="blocker.fix && isAdmin"
				:to="blocker.fix.to"
				class="link font-medium"
				data-testid="send-blocked-fix"
			>
				{{ t(blocker.fix.labelKey) }}
			</NuxtLink>
			<p v-else-if="blocker.fix" class="text-text-secondary">
				{{ t('shared.campaignRefusal.askAdmin') }}
			</p>
		</div>
	</div>
</template>
