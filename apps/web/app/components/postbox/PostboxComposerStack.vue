<script setup lang="ts">
const { state } = usePostboxComposerStack();
</script>

<template>
	<Teleport to="body">
		<PostboxComposerPopup
			v-for="(composer, idx) in state"
			:key="composer.id"
			:composer="composer"
			:index="idx"
		/>
		<PostboxUndoSendToast />
	</Teleport>
</template>
