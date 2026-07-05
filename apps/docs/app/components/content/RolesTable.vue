<script setup lang="ts">
const roles = [
	{
		name: 'owner',
		capabilities: ['Full access', 'Delete team', 'Transfer ownership'],
	},
	{
		name: 'admin',
		capabilities: ['Full access', 'Manage members', 'Cannot manage owners'],
	},
	{
		name: 'editor',
		capabilities: ['Create & edit content', 'No team management'],
	},
];
</script>

<template>
	<div class="roles-table">
		<div class="rt-grid">
			<div v-for="role in roles" :key="role.name" class="rt-role">
				<div class="rt-role-header">
					<code class="rt-role-name">{{ role.name }}</code>
				</div>
				<ul class="rt-caps">
					<li v-for="cap in role.capabilities" :key="cap" class="rt-cap">
						{{ cap }}
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>

<style scoped>
.roles-table {
	margin: 2rem 0;
}

.rt-grid {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 10px;
}

@media (max-width: 580px) {
	.rt-grid {
		grid-template-columns: 1fr;
	}
}

.rt-role {
	border: 1px solid var(--color-border-subtle);
	border-radius: 10px;
	padding: 14px 16px;
	background: var(--surface-2);
	box-shadow: var(--shadow-1);
	transition: background var(--motion-fast) var(--ease-spring);
}

.rt-role:hover {
	background: var(--surface-2-hover);
}

.rt-role-header {
	margin-bottom: 12px;
	padding-bottom: 10px;
	border-bottom: 1px solid var(--color-border-subtle);
}

.rt-role-name {
	font-size: 0.875rem;
	font-weight: 550;
	font-family: var(--font-mono);
	color: var(--color-text-primary);
}

.rt-caps {
	list-style: none;
	padding: 0;
	margin: 0;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.rt-cap {
	display: flex;
	align-items: baseline;
	gap: 8px;
	font-size: 0.8125rem;
	color: var(--color-text-secondary);
}

.rt-cap::before {
	content: '–';
	color: var(--color-text-tertiary);
	flex-shrink: 0;
}
</style>
