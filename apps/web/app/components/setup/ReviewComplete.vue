<script setup lang="ts">
/**
 * The setup wizard's finale, shown once the restart has landed: eyebrow, title,
 * one lead, and three real next steps behind the sign-in.
 */
import { setupSignInHref } from '~/composables/useSetupWizard';
import { SETUP_NEXT_STEPS } from '~/composables/setupWizardReview';
import { ArrowRightIcon, PartyPopperIcon } from '@coolicons/vue';

const props = defineProps<{
	/** The same-origin login path the apply endpoint answered with. */
	redirectTarget: string;
}>();

const { t } = useI18n();

/**
 * The finale's exits — every one an ANCHOR, which is what makes the handoff the
 * wizard's single full page load (see `setupSignInHref` for why a load and not a
 * `router.push`). Each row is a real destination behind the sign-in, so the
 * operator leaves pointed at something rather than at a bare login form.
 */
function signInHref(next?: string): string {
	return setupSignInHref(props.redirectTarget, next);
}
</script>

<template>
	<div class="relative mx-auto max-w-2xl px-6 py-12">
		<!-- Setup ends on an acknowledgement, not on a login form. Every exit from
		     here is an anchor, so leaving IS the single page load the restarted
		     process needs (see `signInHref`) — there is no second reload anywhere
		     in this flow. -->
		<div class="flex items-center gap-3 mb-8">
			<UiIconBox :icon="PartyPopperIcon" size="md" variant="brand" rounded="xl" />
			<span class="lp-eyebrow">{{ t('setup.review.complete.eyebrow') }}</span>
		</div>

		<header class="mb-6">
			<I18nT
				keypath="setup.review.complete.title"
				tag="h1"
				scope="global"
				class="text-3xl font-medium tracking-[-0.02em] mb-2"
			>
				<template #accent>
					<span class="lp-title-accent">{{ t('setup.review.complete.titleAccent') }}</span>
				</template>
			</I18nT>
			<p class="max-w-[34rem] text-text-secondary leading-relaxed">
				{{ t('setup.review.complete.intro') }}
			</p>
		</header>

		<h2 class="lp-eyebrow mb-3">{{ t('setup.review.complete.nextHeading') }}</h2>
		<ul class="space-y-2">
			<li v-for="step in SETUP_NEXT_STEPS" :key="step.id">
				<a
					:href="signInHref(step.to)"
					class="flex items-center gap-4 rounded-xl bg-surface-1 shadow-surface-1 border border-transparent px-4 py-3 transition-[box-shadow] duration-(--motion-fast) ease-spring hover:shadow-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				>
					<component :is="step.icon" class="h-5 w-5 shrink-0 text-text-tertiary" />
					<span class="min-w-0 flex-1">
						<span class="block font-medium text-text-primary">{{
							t(`setup.review.complete.next.${step.id}.title`)
						}}</span>
						<span class="block text-sm text-text-secondary">{{
							t(`setup.review.complete.next.${step.id}.desc`)
						}}</span>
					</span>
					<span class="shrink-0 text-caption text-text-tertiary">{{
						t(`setup.review.complete.next.${step.id}.meta`)
					}}</span>
				</a>
			</li>
		</ul>

		<div class="mt-8">
			<UiButton size="lg" :href="signInHref()">
				{{ t('setup.review.complete.signIn') }}
				<template #iconRight><ArrowRightIcon class="w-4 h-4 ml-2" /></template>
			</UiButton>
		</div>
	</div>
</template>
