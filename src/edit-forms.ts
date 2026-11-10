import { YCError } from './errors.js';
import { identifierPattern } from './graphql.js';
import { assertJSON } from './json.js';

export type EditKind = 'full' | 'progress' | 'fundraise' | 'cofounder';
export interface EditField {
  field: string;
  label: string;
  required: boolean;
}
export interface EditForm {
  kind: EditKind;
  groups: { name: string; fields: EditField[] }[];
}
export interface EditDiscovery {
  appUuid: string;
  forms: EditForm[];
  visibleUpdateKinds: string[];
  unavailable: { kind: string; httpStatus: number }[];
}

// Parse only observed JSON hydration props. Never execute HTML or JavaScript.
export function parseEditForm(source: string, appUuid: string, kind: EditKind | '') {
  let form: EditForm | undefined;
  let visibleUpdateKinds: string[] = [];
  for (const match of source.matchAll(/component:\s*"([^"]+)",\s*props:\s*([^\n]+)\n\}\)/g)) {
    if (!['components/AppForm', 'components/ChooseUpdateKind'].includes(match[1]!)) continue;
    let props;
    try {
      props = JSON.parse(match[2]!);
      assertJSON(props, 'INVALID_EDIT_FORM', 30, 30_000);
      if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error();
    } catch {
      throw new YCError(
        'INVALID_EDIT_FORM',
        'YC edit metadata is malformed. No fields were inferred.',
      );
    }
    if (match[1] === 'components/ChooseUpdateKind') {
      if (props.visibleUpdateKinds && typeof props.visibleUpdateKinds === 'object')
        visibleUpdateKinds = Object.keys(props.visibleUpdateKinds)
          .filter((key) => identifierPattern.test(key))
          .slice(0, 20);
      continue;
    }
    if (
      !kind ||
      props.app_uuid !== appUuid ||
      props.update_kind !== kind ||
      !props.active_question_groups
    )
      throw new YCError(
        'INVALID_EDIT_FORM',
        'YC edit metadata does not match the requested application and update kind.',
      );
    if (form) throw new YCError('INVALID_EDIT_FORM', 'YC returned conflicting edit forms.');
    const groups: EditForm['groups'] = [];
    for (const [name, fields] of Object.entries(props.active_question_groups)) {
      if (
        name.length > 200 ||
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        groups.length >= 20
      )
        throw new YCError('INVALID_EDIT_FORM', 'YC edit metadata exceeds its structural limits.');
      const entries: EditField[] = [];
      for (const [field, metadata] of Object.entries(fields)) {
        if (!identifierPattern.test(field) || field.length > 128 || entries.length >= 100)
          throw new YCError('INVALID_EDIT_FORM', 'YC edit field metadata is invalid.');
        const prompt =
          metadata && typeof metadata === 'object'
            ? (metadata as { prompt?: { q?: unknown; required?: unknown } }).prompt
            : null;
        const label = typeof prompt?.q === 'string' ? prompt.q.slice(0, 2000) : field;
        entries.push({ field, label, required: prompt?.required === true });
      }
      groups.push({ name, fields: entries });
    }
    form = { kind, groups };
  }
  return { form, visibleUpdateKinds };
}
