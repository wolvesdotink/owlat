import { computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { DraftAutosave } from './useDraftAutosave';

/**
 * Publish and unpublish from the email template editor.
 *
 * Publish puts the row's stored HTML live, which unsaved edits are not part
 * of. A draft's autosave session (`draft`) holds its background saves while
 * Publish runs, saves what is pending through its queue first, and publishes
 * only once that landed; a published template's Publish button is held while
 * it has unsaved changes.
 */
export function useTemplatePublication(opts: {
	templateId: Ref<Id<'emailTemplates'>>;
	template: Ref<
		{ status: string; htmlContent?: string; contentRevision?: number } | null | undefined
	>;
	hasChanges: Readonly<Ref<boolean>>;
	draft: () => DraftAutosave | null;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { run: publishTemplate, isLoading: isPublishing } = useBackendOperation(
		api.emailTemplates.emails.publish,
		{ label: () => t('dashboard.send.emails.detail.edit.operations.publish') }
	);
	const { run: unpublishTemplate, isLoading: isUnpublishing } = useBackendOperation(
		api.emailTemplates.emails.unpublish,
		{ label: () => t('dashboard.send.emails.detail.edit.operations.unpublish') }
	);
	const isPublished = computed(() => opts.template.value?.status === 'published');

	const publishStored = async (): Promise<boolean> => {
		const row = opts.template.value;
		if (!row?.htmlContent) {
			showToast(t('dashboard.send.emails.detail.edit.toasts.saveBeforePublish'), 'error');
			return false;
		}
		// The server publishes the row's own stored HTML, and refuses while a
		// saved-block rerender is still bringing it up to date. The revision makes
		// a write landing after this click refuse the publish instead of putting
		// a version live that this tab never showed.
		const result = await publishTemplate({
			templateId: opts.templateId.value,
			expectedContentRevision: row.contentRevision ?? 0,
		});
		if (result.ok) showToast(t('dashboard.send.emails.detail.edit.toasts.published'));
		return result.ok;
	};

	const togglePublication = async () => {
		if (isPublished.value) {
			const result = await unpublishTemplate({ templateId: opts.templateId.value });
			if (result.ok) showToast(t('dashboard.send.emails.detail.edit.toasts.unpublished'));
			return;
		}
		const draft = opts.draft();
		if (draft) {
			await draft.runAction(async (current) => {
				if (!(await draft.flush())) {
					showToast(t('shared.draftAutosave.notSavedYet'), 'error');
					return false;
				}
				// What goes live is the stored draft: it must still be what the editor shows.
				if (!current()) {
					showToast(t('shared.draftAutosave.changedDuringAction'), 'error');
					return false;
				}
				return publishStored();
			});
			return;
		}
		// The button holds Publish while dirty; this covers any other caller.
		if (!opts.hasChanges.value) await publishStored();
	};

	return {
		isPublished,
		isChangingPublication: computed(() => isPublishing.value || isUnpublishing.value),
		togglePublication,
	};
}
