<script setup lang="ts">
/**
 * The small print under the sign-in card.
 *
 * An instance belongs to its operator, so the legal links are theirs: the
 * Terms and Imprint pages render the operator's `company*` runtime config.
 * When the operator has not configured any, those pages would be empty, so
 * the footer says "Powered by Owlat" instead of linking to them. The Terms
 * page only carries terms on the hosted deployment (see `pages/terms.vue`), so
 * a self-hosted footer links the Imprint alone.
 */
import {
	hasOperatorLegalPages,
	hasPublishedTerms,
	workspaceDisplayName,
} from '~/utils/instanceEntry';

const { t } = useI18n();
const config = useRuntimeConfig().public;

const showLegalLinks = hasOperatorLegalPages(config);
const showTerms = hasPublishedTerms(config);
const operatorName = workspaceDisplayName(config);
</script>

<template>
	<footer class="mt-8 text-center text-xs text-text-tertiary">
		<p v-if="showLegalLinks" class="space-x-1">
			<span>{{ operatorName }}</span>
			<template v-if="showTerms">
				<span aria-hidden="true">&middot;</span>
				<NuxtLink to="/terms" class="underline underline-offset-2 hover:text-text-secondary">{{
					t('home.footer.terms')
				}}</NuxtLink>
			</template>
			<span aria-hidden="true">&middot;</span>
			<NuxtLink to="/imprint" class="underline underline-offset-2 hover:text-text-secondary">{{
				t('home.footer.imprint')
			}}</NuxtLink>
		</p>
		<I18nT v-else keypath="auth.footer.poweredBy" tag="p" scope="global">
			<template #owlat>
				<a
					href="https://owlat.app"
					target="_blank"
					rel="noopener"
					class="underline underline-offset-2 hover:text-text-secondary"
					>Owlat</a
				>
			</template>
		</I18nT>
	</footer>
</template>
