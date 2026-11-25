<script setup lang="ts">
/**
 * What runs on new mail in a mailbox synced from its provider. That mail skips
 * the editor's filters, and a team inbox also runs no plain-language rules, so
 * a filter there applies only through "Run on existing mail". Renders nothing
 * for a hosted mailbox.
 */
import { filtersOnNewMail, type FilterMailbox } from '~/composables/postbox/usePostboxFilters';

const props = defineProps<{ mailbox: FilterMailbox & { address?: string } }>();

const { t } = useI18n();

const onNewMail = computed(() => filtersOnNewMail(props.mailbox));
</script>

<template>
	<p
		v-if="!onNewMail.editorFilters"
		class="card p-6 mb-6 text-text-secondary"
		data-testid="connected-mailbox-notice"
	>
		{{
			t(
				onNewMail.plainRules
					? 'dashboard.preferences.filters.connectedNotice'
					: 'dashboard.preferences.filters.connectedTeamNotice',
				{ address: mailbox.address }
			)
		}}
	</p>
</template>
