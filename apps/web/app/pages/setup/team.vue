<script setup lang="ts">
/**
 * Redirect. The access-request screen is not a setup step.
 *
 * It lived here — inside the first-run wizard's namespace, beside `/setup/mode`
 * and `/setup/review` — while being neither run by the operator nor part of the
 * wizard: it is what an ordinary member sees when they are signed in but belong
 * to no organization. It now answers on `/access-request`.
 *
 * The route survives because sessions, bookmarks and the auth middleware's older
 * signature all pointed here.
 */
definePageMeta({
	layout: false,
});

// No `auth` middleware here: the destination carries it, so a signed-out visitor
// is sent to login by the page they actually land on rather than by the stub.
await navigateTo('/access-request', { replace: true, redirectCode: 301 });
</script>

<template>
	<div />
</template>
