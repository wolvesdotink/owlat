<script setup lang="ts">
interface Candidate {
	memberId: string;
	name: string | null;
	email: string | null;
	image: string | null;
	handle: string | null;
}

interface Props {
	candidates: Candidate[];
}

defineProps<Props>();
const emit = defineEmits<{ pick: [handle: string] }>();
</script>

<template>
	<div
		class="absolute bottom-full left-4 right-4 mb-2 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl max-h-64 overflow-y-auto z-20"
	>
		<button
			v-for="candidate in candidates"
			:key="candidate.memberId"
			class="w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-bg-surface text-sm"
			@mousedown.prevent="emit('pick', candidate.handle ?? candidate.email?.split('@')[0] ?? candidate.memberId)"
		>
			<div class="w-6 h-6 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center text-[10px] font-medium text-text-tertiary overflow-hidden">
				<img v-if="candidate.image" :src="candidate.image" class="w-full h-full object-cover" :alt="candidate.name ?? ''" />
				<span v-else>{{ (candidate.name ?? candidate.email ?? '?').slice(0, 2).toUpperCase() }}</span>
			</div>
			<span class="text-text-primary">{{ candidate.name ?? candidate.email ?? candidate.memberId }}</span>
			<span v-if="candidate.handle" class="text-text-tertiary text-xs">@{{ candidate.handle }}</span>
		</button>
	</div>
</template>
