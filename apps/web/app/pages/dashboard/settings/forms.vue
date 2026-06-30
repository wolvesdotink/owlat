<script setup lang="ts">
useHead({ title: 'Forms — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const {
	formsData, topicsData, isLoading,
	isAddModalOpen, addForm, addFormErrors, isAdding, resetAddForm, handleAddForm, addFieldEditor,
	formToEdit, editForm, editFormErrors, isSaving, openEditModal, handleSaveEdit, editFieldEditor,
	handleToggleActive,
	formToDelete, isDeleting, handleDeleteForm,
	expandedFormId, copiedCode, toggleFormExpansion, getFormUrl, getEmbedCode, copyToClipboard,
	getTopicName, formatDate,
} = useFormSettings();

const { hasActiveOrganization } = useOrganizationContext();
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Form Endpoints</h1>
					<p class="mt-1 text-text-secondary">Create embeddable signup forms for your website</p>
				</div>
				<button class="btn btn-primary gap-2" @click="isAddModalOpen = true">
					<Icon name="lucide:plus" class="w-4 h-4" />
					New Form
				</button>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading && !formsData" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading forms...</p>
			</div>
		</div>

		<!-- No Organization State -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:file-text" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No organization selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select an organization to manage form endpoints.
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:code" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">What are form endpoints?</h3>
						<p class="text-sm text-text-secondary">
							Form endpoints let you collect email signups directly from your website. Create a
							form, configure the fields, and embed the HTML code on any webpage. Submissions are
							automatically added as contacts and optionally to a topic.
						</p>
					</div>
				</div>
			</div>

			<!-- Empty State -->
			<div
				v-if="formsData && formsData.length === 0"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:file-text" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No form endpoints yet</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create your first form endpoint to start collecting signups from your website.
				</p>
				<button class="btn btn-primary gap-2 mt-4" @click="isAddModalOpen = true">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Create Your First Form
				</button>
			</div>

			<!-- Forms List -->
			<div v-else-if="formsData && formsData.length > 0" class="space-y-4">
				<div v-for="form in formsData" :key="form._id" class="card p-0 overflow-hidden">
					<!-- Form Header -->
					<div
						class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors"
						@click="toggleFormExpansion(form._id)"
					>
						<div class="flex items-center gap-4">
							<UiIconBox icon="lucide:file-text" size="sm" variant="surface" rounded="lg" />
							<div>
								<div class="flex items-center gap-3">
									<p class="font-medium text-text-primary">{{ form.name }}</p>
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
											form.isActive
												? 'bg-success/20 text-success border-success/30'
												: 'bg-text-tertiary/20 text-text-tertiary border-text-tertiary/30',
										]"
									>
										<Icon :name="form.isActive ? 'lucide:check-circle-2' : 'lucide:x-circle'" class="w-3 h-3" />
										{{ form.isActive ? 'Active' : 'Inactive' }}
									</span>
								</div>
								<div class="flex items-center gap-4 mt-1 text-sm text-text-tertiary">
									<span>Topic: {{ getTopicName(form.topicId) }}</span>
									<span class="text-border-default">&bull;</span>
									<span>{{ form.totalSubmissions }} submissions</span>
									<span class="text-border-default">&bull;</span>
									<span>Created {{ formatDate(form.createdAt) }}</span>
								</div>
							</div>
						</div>

						<div class="flex items-center gap-2">
							<!-- Toggle Active -->
							<button
								class="btn btn-ghost p-2"
								:title="form.isActive ? 'Disable form' : 'Enable form'"
								@click.stop="handleToggleActive(form)"
							>
								<Icon
									:name="form.isActive ? 'lucide:toggle-right' : 'lucide:toggle-left'"
									:class="['w-5 h-5', form.isActive ? 'text-success' : 'text-text-tertiary']"
								/>
							</button>
							<!-- Edit -->
							<button class="btn btn-ghost p-2" title="Edit form" @click.stop="openEditModal(form as Parameters<typeof openEditModal>[0])">
								<Icon name="lucide:settings-2" class="w-4 h-4" />
							</button>
							<!-- Delete -->
							<button
								class="btn btn-ghost p-2 text-error hover:bg-error/10"
								title="Delete form"
								@click.stop="
									formToDelete = {
										_id: form._id,
										name: form.name,
										totalSubmissions: form.totalSubmissions,
									}
								"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</button>
							<!-- Expand Arrow -->
							<div
								:class="[
									'w-5 h-5 flex items-center justify-center transition-transform',
									expandedFormId === form._id ? 'rotate-180' : '',
								]"
							>
								<svg
									class="w-4 h-4 text-text-tertiary"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</div>
						</div>
					</div>

					<!-- Expanded Content (Embed Code & Stats) -->
					<Transition name="expand">
						<div v-if="expandedFormId === form._id" class="border-t border-border-subtle">
							<div class="px-6 py-4 bg-bg-surface/30 space-y-6">
								<!-- Stats Section -->
								<div>
									<h4 class="text-sm font-medium text-text-primary mb-3">Submission Statistics</h4>
									<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
										<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
											<div class="flex items-center gap-2 mb-1">
												<Icon name="lucide:inbox" class="w-4 h-4 text-text-tertiary" />
												<span class="text-xs text-text-tertiary">Total</span>
											</div>
											<p class="text-xl font-semibold text-text-primary">
												{{ form.totalSubmissions }}
											</p>
										</div>
										<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
											<div class="flex items-center gap-2 mb-1">
												<Icon name="lucide:check-circle-2" class="w-4 h-4 text-success" />
												<span class="text-xs text-text-tertiary">Successful</span>
											</div>
											<p class="text-xl font-semibold text-success">
												{{ form.successfulSubmissions }}
											</p>
										</div>
										<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
											<div class="flex items-center gap-2 mb-1">
												<Icon name="lucide:alert-triangle" class="w-4 h-4 text-warning" />
												<span class="text-xs text-text-tertiary">Other</span>
											</div>
											<!-- Everything not successful: pending double-opt-in, spam, invalid,
												and duplicates. The backend denormalizes only total + successful,
												so this is the honest derived remainder (not just duplicates). -->
											<p class="text-xl font-semibold text-warning">
												{{ form.totalSubmissions - form.successfulSubmissions }}
											</p>
										</div>
									</div>
								</div>

								<!-- Recent submissions -->
								<FormsSubmissionsPanel :form-endpoint-id="form._id" />

								<!-- Endpoint URL -->
								<div>
									<h4 class="text-sm font-medium text-text-primary mb-2">Form Endpoint URL</h4>
									<div class="flex items-center gap-2">
										<code
											class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
										>
											{{ getFormUrl(form._id) }}
										</code>
										<button
											class="btn btn-ghost p-2"
											title="Copy URL"
											@click="copyToClipboard(getFormUrl(form._id), `url-${form._id}`)"
										>
											<Icon v-if="copiedCode === `url-${form._id}`" name="lucide:check" class="w-4 h-4 text-success" />
											<Icon v-else name="lucide:copy" class="w-4 h-4" />
										</button>
									</div>
								</div>

								<!-- Embed Code -->
								<div>
									<div class="flex items-center justify-between mb-2">
										<h4 class="text-sm font-medium text-text-primary">Embed Code</h4>
										<button
											class="btn btn-ghost gap-1.5 text-sm py-1.5 px-3"
											@click="copyToClipboard(getEmbedCode(form), `embed-${form._id}`)"
										>
											<Icon
												v-if="copiedCode === `embed-${form._id}`"
												name="lucide:check"
												class="w-4 h-4 text-success"
											/>
											<Icon v-else name="lucide:copy" class="w-4 h-4" />
											{{ copiedCode === `embed-${form._id}` ? 'Copied!' : 'Copy Code' }}
										</button>
									</div>
									<pre
										class="bg-bg-deep px-4 py-3 rounded-lg text-sm text-text-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all"
										>{{ getEmbedCode(form) }}</pre
									>
								</div>

								<!-- Help Text -->
								<div class="p-4 bg-bg-surface rounded-xl border border-border-subtle">
									<p class="text-sm text-text-secondary">
										<strong class="text-text-primary">Tip:</strong> Copy this HTML and paste it into
										your website. Style the form with CSS to match your design. The form will submit
										data directly to your Owlat account.
										<a
											href="https://docs.owlat.app/developer/forms"
											target="_blank"
											rel="noopener"
											class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
										>
											Learn more
											<Icon name="lucide:external-link" class="w-3 h-3" />
										</a>
									</p>
								</div>
							</div>
						</div>
					</Transition>
				</div>
			</div>
		</div>

		<!-- Add Form Modal -->
		<UiModal
			:open="isAddModalOpen"
			title="Create Form Endpoint"
			size="md"
			@update:open="(v) => { if (!v) isAddModalOpen = false; }"
		>
			<form id="add-form" @submit.prevent="handleAddForm">
				<div class="space-y-4">
					<!-- Name Input -->
					<div>
						<label for="form-name" class="label">
							Form Name <span class="text-error">*</span>
						</label>
						<input
							id="form-name"
							v-model="addForm.name"
							type="text"
							placeholder="e.g., Newsletter Signup"
							:class="['input', addFormErrors.name && 'input-error']"
							:disabled="isAdding"
						/>
						<p v-if="addFormErrors.name" class="mt-1 text-xs text-error">
							{{ addFormErrors.name }}
						</p>
					</div>

					<!-- Topic Select -->
					<div>
						<label for="form-topic" class="label"> Add to Topic </label>
						<select
							id="form-topic"
							v-model="addForm.topicId"
							class="input"
							:disabled="isAdding"
						>
							<option value="">None (contacts only)</option>
							<option v-for="list in topicsData" :key="list._id" :value="list._id">
								{{ list.name }}
							</option>
						</select>
						<p class="mt-1 text-xs text-text-tertiary">
							New signups will be added to this topic automatically.
						</p>
					</div>

					<!-- Fields Editor -->
					<FormsFieldsEditor
						:fields="addForm.fields"
						:editor="addFieldEditor"
						:error="addFormErrors.fields"
						:disabled="isAdding"
						id-prefix="add"
					/>

					<!-- Redirect URL -->
					<div>
						<label for="form-redirect" class="label"> Redirect URL (optional) </label>
						<input
							id="form-redirect"
							v-model="addForm.redirectUrl"
							type="url"
							placeholder="https://example.com/thank-you"
							class="input"
							:disabled="isAdding"
						/>
						<p class="mt-1 text-xs text-text-tertiary">
							Redirect users here after successful signup. Leave empty for JSON response.
						</p>
					</div>

					<!-- Honeypot Field -->
					<div>
						<label for="form-honeypot" class="label"> Honeypot Field Name (optional) </label>
						<input
							id="form-honeypot"
							v-model="addForm.honeypotFieldName"
							type="text"
							placeholder="e.g., website_url"
							class="input"
							:disabled="isAdding"
						/>
						<p class="mt-1 text-xs text-text-tertiary">
							A hidden field for spam prevention. Bots fill it in, humans don't.
						</p>
					</div>

					<!-- Double Opt-In -->
					<div class="flex items-start gap-3 pt-2">
						<input
							id="form-double-optin"
							v-model="addForm.doubleOptIn"
							type="checkbox"
							class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
							:disabled="isAdding"
						/>
						<div>
							<label
								for="form-double-optin"
								class="text-sm font-medium text-text-primary cursor-pointer"
							>
								Enable Double Opt-In
							</label>
							<p class="mt-0.5 text-xs text-text-tertiary">
								Require email confirmation before subscribing. Recommended for GDPR
								compliance.
							</p>
						</div>
					</div>
				</div>
			</form>

			<template #footer>
				<button
					type="button"
					class="btn btn-secondary"
					:disabled="isAdding"
					@click="
						isAddModalOpen = false;
						resetAddForm();
					"
				>
					Cancel
				</button>
				<button type="submit" form="add-form" class="btn btn-primary gap-2" :disabled="isAdding">
					<Icon v-if="isAdding" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:plus" class="w-4 h-4" />
					{{ isAdding ? 'Creating...' : 'Create Form' }}
				</button>
			</template>
		</UiModal>

		<!-- Edit Form Modal -->
		<UiModal
			:open="!!formToEdit"
			title="Edit Form Endpoint"
			size="md"
			@update:open="(v) => { if (!v) formToEdit = null; }"
		>
			<form id="edit-form" @submit.prevent="handleSaveEdit">
				<div class="space-y-4">
					<!-- Name Input -->
					<div>
						<label for="edit-form-name" class="label">
							Form Name <span class="text-error">*</span>
						</label>
						<input
							id="edit-form-name"
							v-model="editForm.name"
							type="text"
							placeholder="e.g., Newsletter Signup"
							:class="['input', editFormErrors.name && 'input-error']"
							:disabled="isSaving"
						/>
						<p v-if="editFormErrors.name" class="mt-1 text-xs text-error">
							{{ editFormErrors.name }}
						</p>
					</div>

					<!-- Topic Select -->
					<div>
						<label for="edit-form-topic" class="label"> Add to Topic </label>
						<select
							id="edit-form-topic"
							v-model="editForm.topicId"
							class="input"
							:disabled="isSaving"
						>
							<option value="">None (contacts only)</option>
							<option v-for="list in topicsData" :key="list._id" :value="list._id">
								{{ list.name }}
							</option>
						</select>
					</div>

					<!-- Fields Editor -->
					<FormsFieldsEditor
						:fields="editForm.fields"
						:editor="editFieldEditor"
						:error="editFormErrors.fields"
						:disabled="isSaving"
						id-prefix="edit"
					/>

					<!-- Redirect URL -->
					<div>
						<label for="edit-form-redirect" class="label"> Redirect URL (optional) </label>
						<input
							id="edit-form-redirect"
							v-model="editForm.redirectUrl"
							type="url"
							placeholder="https://example.com/thank-you"
							class="input"
							:disabled="isSaving"
						/>
					</div>

					<!-- Honeypot Field -->
					<div>
						<label for="edit-form-honeypot" class="label">
							Honeypot Field Name (optional)
						</label>
						<input
							id="edit-form-honeypot"
							v-model="editForm.honeypotFieldName"
							type="text"
							placeholder="e.g., website_url"
							class="input"
							:disabled="isSaving"
						/>
					</div>

					<!-- Double Opt-In -->
					<div class="flex items-start gap-3 pt-2">
						<input
							id="edit-form-double-optin"
							v-model="editForm.doubleOptIn"
							type="checkbox"
							class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
							:disabled="isSaving"
						/>
						<div>
							<label
								for="edit-form-double-optin"
								class="text-sm font-medium text-text-primary cursor-pointer"
							>
								Enable Double Opt-In
							</label>
							<p class="mt-0.5 text-xs text-text-tertiary">
								Require email confirmation before subscribing. Recommended for GDPR
								compliance.
							</p>
						</div>
					</div>
				</div>
			</form>

			<template #footer>
				<button
					type="button"
					class="btn btn-secondary"
					:disabled="isSaving"
					@click="formToEdit = null"
				>
					Cancel
				</button>
				<button type="submit" form="edit-form" class="btn btn-primary gap-2" :disabled="isSaving">
					<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:check" class="w-4 h-4" />
					{{ isSaving ? 'Saving...' : 'Save Changes' }}
				</button>
			</template>
		</UiModal>

		<!-- Delete Form Confirmation Modal -->
		<UiConfirmationDialog
			:open="!!formToDelete"
			variant="danger"
			title="Delete Form Endpoint"
			:description="`Are you sure you want to delete &quot;${formToDelete?.name ?? ''}&quot;?`"
			confirm-text="Delete Form"
			:is-loading="isDeleting"
			@update:open="(v: boolean) => { if (!v) formToDelete = null; }"
			@confirm="handleDeleteForm"
		>
			<p
				v-if="formToDelete && formToDelete.totalSubmissions > 0"
				class="mt-2 text-sm text-warning"
			>
				This will also delete {{ formToDelete.totalSubmissions }} submission record(s).
			</p>
			<p class="mt-2 text-sm text-text-tertiary">
				This action cannot be undone. The form will stop accepting submissions immediately.
			</p>
		</UiConfirmationDialog>
	</div>
</template>

<style scoped>
.expand-enter-active,
.expand-leave-active { transition: all 0.2s ease; overflow: hidden; }
.expand-enter-from,
.expand-leave-to { opacity: 0; max-height: 0; }
.expand-enter-to,
.expand-leave-from { max-height: 1500px; }
</style>
