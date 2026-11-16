import type { UserCameraProfile } from '../../api';
import type { IconKind } from '../../types';
import { STARTER_PATTERN } from '../../lib/cameraPattern';

export type ViewConfigEntry = { id: string; iconKind: IconKind };

/** Editable copy of a profile (WEB-SET-CAMERAS-025). */
export interface Draft {
  name: string;
  regex: string;
  priority: number;
  views: ViewConfigEntry[];
}

export const NEW_KEY = 'new';

export function draftFromProfile(p: UserCameraProfile): Draft {
  return {
    name: p.name,
    regex: p.regex,
    priority: p.priority,
    views: p.viewsConfig.length > 0
      ? p.viewsConfig.map(v => ({ id: v.id, iconKind: v.iconKind }))
      : [{ id: p.viewDefault, iconKind: 'generic' }],
  };
}

export function newDraft(name: string): Draft {
  return { name, regex: STARTER_PATTERN, priority: 10, views: [{ id: '00', iconKind: 'generic' }] };
}

/**
 * Drop blank-id rows and guarantee at least one entry (WEB-SET-CAMERAS-042).
 * The server then always receives a valid 1..16 array with non-empty ids.
 */
export function sanitizeViews(views: ViewConfigEntry[]): ViewConfigEntry[] {
  const cleaned = views
    .map(v => ({ id: v.id.trim(), iconKind: v.iconKind }))
    .filter(v => v.id.length > 0);
  return cleaned.length > 0 ? cleaned : [{ id: '00', iconKind: 'generic' }];
}

/**
 * WEB-SET-CAMERAS-045. The thumbnail worker takes the LOWEST view id as the
 * primary view (WORKER-020), so the editor's display order must be the id
 * order: every id sorts after the one above it, compared as text.
 */
export function viewIdsInOrder(views: ViewConfigEntry[]): boolean {
  return views.every((v, i) => i === 0 || v.id > views[i - 1].id);
}

const sameViews = (a: ViewConfigEntry[], b: ViewConfigEntry[]) =>
  a.length === b.length && a.every((v, i) => v.id === b[i].id && v.iconKind === b[i].iconKind);

/** The fields of `draft` that differ from the stored profile. */
export function changedFields(draft: Draft, p: UserCameraProfile): Partial<{
  name: string; regex: string; priority: number; viewsConfig: ViewConfigEntry[];
}> {
  const out: ReturnType<typeof changedFields> = {};
  if (draft.name.trim() !== p.name) out.name = draft.name.trim();
  if (draft.regex.trim() !== p.regex) out.regex = draft.regex.trim();
  if (draft.priority !== p.priority) out.priority = draft.priority;
  const cleaned = sanitizeViews(draft.views);
  if (!sameViews(cleaned, p.viewsConfig)) out.viewsConfig = cleaned;
  return out;
}

export function isDirty(draft: Draft, p: UserCameraProfile): boolean {
  return Object.keys(changedFields(draft, p)).length > 0;
}

export function byPriority<T extends { priority: number; id: number }>(a: T, b: T): number {
  return a.priority - b.priority || a.id - b.id;
}
