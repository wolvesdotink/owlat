import { entryTypeLabel, relationLabel, sourceLabel } from '~/utils/knowledgeEntryTypes';

/**
 * Entry-type / source / relation labels for the knowledge entry detail page and
 * its cards. They are translated here; the shared presentation map
 * (`~/utils/knowledgeEntryTypes`) stays a plain constant, so an unknown value
 * still falls back to its raw label instead of a key path.
 */
export function useKnowledgeDetailLabels() {
	const { t, te } = useI18n();

	const entryTypeName = (type: string): string => {
		const key = `dashboard.knowledge.detail.entryTypes.${type}`;
		return te(key) ? t(key) : entryTypeLabel(type);
	};
	const sourceTypeName = (source: string): string => {
		const key = `dashboard.knowledge.detail.sourceTypes.${source}`;
		return te(key) ? t(key) : sourceLabel(source);
	};
	const relationTypeName = (type: string): string => {
		const key = `dashboard.knowledge.detail.relationTypes.${type}`;
		return te(key) ? t(key) : relationLabel(type);
	};

	return { entryTypeName, sourceTypeName, relationTypeName };
}
