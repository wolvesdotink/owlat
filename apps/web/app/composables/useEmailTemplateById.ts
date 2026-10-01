import type { MaybeRefOrGetter } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * One email template, read by id.
 *
 * The template pickers page and search their lists, so the selected template
 * is often not among the rows on screen. Reading it on its own keeps the
 * selection visible whatever the list currently shows. Skipped while there is
 * no id.
 */
export function useEmailTemplateById(
	templateId: MaybeRefOrGetter<Id<'emailTemplates'> | null | undefined>
) {
	return useOrganizationQuery(api.emailTemplates.emails.get, () => {
		const id = toValue(templateId);
		return id ? { templateId: id } : undefined;
	});
}
