/**
 * Dashboard card renderers now live in the generalised panel/widget registry
 * (`~/composables/widgets/dashboardWidgets`). This module is retained as the
 * stable import site for `RENDERABLE_CARD_TYPES` — the set of card types that
 * have a renderer — which the add-menu (`DashboardEditor`) filters against.
 */
export { RENDERABLE_CARD_TYPES } from '~/composables/widgets/dashboardWidgets';
