<script setup lang="ts">
useHead({
	title: 'Owlat - Email Marketing Made Simple',
});
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col">
		<!-- Navigation -->
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<div class="font-display text-2xl text-text-primary">Owlat</div>
			<NuxtLink to="/auth/login" class="btn btn-ghost"> Sign In </NuxtLink>
		</nav>

		<!-- Hero Section -->
		<main class="flex-1 flex flex-col items-center justify-center px-6 text-center">
			<h1 class="font-display text-5xl lg:text-6xl text-text-primary mb-6 max-w-3xl">
				Email Marketing
				<span class="text-brand">Made Simple</span>
			</h1>
			<p class="text-xl text-text-secondary mb-10 max-w-2xl">
				Build beautiful emails, grow your audience, and track what works. Everything you need to
				connect with your customers.
			</p>
			<div class="flex flex-col sm:flex-row gap-4">
				<NuxtLink to="/auth/register" class="btn btn-primary px-8 py-3 text-lg">
					Get Started Free
				</NuxtLink>
				<NuxtLink to="/auth/login" class="btn btn-secondary px-8 py-3 text-lg"> Sign In </NuxtLink>
			</div>
		</main>

		<!-- Footer -->
		<footer class="px-6 py-8 text-center text-text-tertiary text-sm space-y-2">
			<p>&copy; {{ new Date().getFullYear() }} <a href="https://wolves.ink">Wolves</a>. All rights reserved.</p>
			<p>
				<NuxtLink to="/terms" class="hover:text-text-secondary">Terms of Service</NuxtLink>
				<span class="mx-1">&middot;</span>
				<NuxtLink to="/imprint" class="hover:text-text-secondary">Imprint</NuxtLink>
			</p>
		</footer>
	</div>
</template>
