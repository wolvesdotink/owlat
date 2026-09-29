/**
 * The element every undo countdown toast teleports into. The dashboard and
 * compose layouts render it once, bottom-left, as a column, so two live undo
 * windows (a mail send and a review approve on the Answer page) stack instead
 * of drawing one over the other.
 */
export const UNDO_TOAST_REGION_ID = 'undo-toast-region';
