import { ValidationError } from "@chat-adapter/shared";
import type {
  DateInputElement,
  ExternalSelectElement,
  ModalElement,
  NumberInputElement,
  OptionsLoadResult,
  RadioSelectElement,
  SelectElement,
  SelectOptionElement,
  TextInputElement,
} from "chat";
import { cardToText } from "./cards";
import type { ChatwootModalTexts } from "./types";

export type Field =
  | DateInputElement
  | ExternalSelectElement
  | NumberInputElement
  | RadioSelectElement
  | SelectElement
  | TextInputElement;

/** A modal under way in one conversation with one contact: what is left to ask, and what they answered. */
export interface Form {
  callbackId: string;
  closeLabel?: string;
  contextId?: string;
  fields: Field[];
  /** Options a search for the current field found, waiting for a pick. */
  found?: SelectOptionElement[];
  /** The native `form` message waiting for its `submitted_values`, when the widget shows one. */
  messageId?: number;
  notifyOnClose?: boolean;
  pending: string[];
  privateMetadata?: string;
  submitLabel?: string;
  values: Record<string, string>;
  viewId: string;
}

/** An item of Chatwoot's `form` content, which the website widget renders as a field. */
export interface ChatwootFormItem {
  default?: string;
  label: string;
  name: string;
  options?: { label: string; value: string }[];
  placeholder?: string;
  type: "select" | "text" | "text_area";
}

/** What an answer did: settled the field, or needs telling the contact why not, or a search first. */
export type Answer =
  { error: string } | { search: string } | { value?: string };

export const DEFAULT_MODAL_TEXTS: ChatwootModalTexts = {
  cancel: "cancel",
  cancelHint: "Send **cancel** to stop.",
  cancelled: "Cancelled.",
  invalid: "That doesn't fit. Try again:",
  noResults: "Nothing matched. Try other words:",
  search: "Send a few words to search.",
  skip: "skip",
  skipHint: "Send **skip** to leave it as it is.",
};

const INPUTS = new Set<string>([
  "date_input",
  "external_select",
  "number_input",
  "radio_select",
  "select",
  "text_input",
]);

/** Opaque to the SDK; carries where a modal opens and for whom, since Chatwoot has no trigger of its own. */
export function triggerIdOf(threadId: string, userId: string): string {
  return JSON.stringify([threadId, userId]);
}

export function fromTrigger(
  triggerId: string,
): [threadId: string, userId: string] {
  let ids: unknown;
  try {
    ids = JSON.parse(triggerId);
  } catch {
    ids = undefined;
  }
  const [threadId, userId] = Array.isArray(ids) ? ids : [];
  if (typeof threadId === "string" && typeof userId === "string")
    return [threadId, userId];
  throw new ValidationError(
    "chatwoot",
    `Not a trigger this adapter issued: ${triggerId}`,
  );
}

export function createForm(
  modal: ModalElement,
  viewId: string,
  contextId?: string,
): Form {
  const fields = modal.children.filter((child): child is Field =>
    INPUTS.has(child.type),
  );
  return {
    callbackId: modal.callbackId,
    closeLabel: modal.closeLabel,
    contextId,
    fields,
    notifyOnClose: modal.notifyOnClose,
    pending: fields.map(({ id }) => id),
    privateMetadata: modal.privateMetadata,
    submitLabel: modal.submitLabel,
    values: {},
    viewId,
  };
}

/** The title and any text or fields the modal shows. */
export function introOf(modal: ModalElement): string {
  const shown = modal.children.filter(
    (child) => child.type === "text" || child.type === "fields",
  );
  return cardToText({ children: shown, title: modal.title, type: "card" });
}

export function currentField(form: Form): Field | undefined {
  return form.fields.find(({ id }) => id === form.pending[0]);
}

function optionsOf(
  field: Field,
  form: Form,
): SelectOptionElement[] | undefined {
  if (field.type === "select" || field.type === "radio_select")
    return field.options;
  return field.type === "external_select" ? form.found : undefined;
}

function initialOf(field: Field): string | undefined {
  switch (field.type) {
    case "select":
    case "radio_select":
      return field.initialOption;
    case "external_select":
      return field.initialOption?.value;
    case "number_input":
      return field.initialValue === undefined
        ? undefined
        : String(field.initialValue);
    default:
      return field.initialValue;
  }
}

export function questionOf(
  field: Field,
  form: Form,
  texts: ChatwootModalTexts,
): string {
  const options = optionsOf(field, form);
  const initial = initialOf(field);
  const shown =
    field.type === "external_select"
      ? field.initialOption?.label
      : (options?.find(({ value }) => value === initial)?.label ?? initial);
  const range =
    field.type === "number_input" &&
    [field.min, field.max].some((n) => n !== undefined);
  return [
    `**${field.label}**`,
    "placeholder" in field && field.placeholder && `_${field.placeholder}_`,
    options
      ?.map((option, index) =>
        [`${index + 1}. ${option.label}`, option.description]
          .filter(Boolean)
          .join(": "),
      )
      .join("\n"),
    field.type === "date_input" && "_YYYY-MM-DD_",
    range && `_${field.min ?? "…"} – ${field.max ?? "…"}_`,
    field.type === "external_select" && !options && `_${texts.search}_`,
    (field.optional || initial !== undefined) &&
      `_${texts.skipHint}_${shown === undefined ? "" : ` (${shown})`}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function pick(
  options: SelectOptionElement[],
  text: string,
): SelectOptionElement | undefined {
  return /^\d+$/.test(text)
    ? options[Number(text) - 1]
    : options.find(({ label }) => label.toLowerCase() === text.toLowerCase());
}

/** Reads one reply against the field it answers; never throws, since the text is anyone's. */
export function answerOf(
  field: Field,
  form: Form,
  text: string,
  texts: ChatwootModalTexts,
): Answer {
  const invalid = { error: texts.invalid };
  if (text.toLowerCase() === texts.skip.toLowerCase()) {
    const initial = initialOf(field);
    return field.optional || initial !== undefined
      ? { value: initial }
      : invalid;
  }
  switch (field.type) {
    case "text_input":
      return text && text.length <= (field.maxLength ?? Infinity)
        ? { value: text }
        : invalid;
    case "number_input": {
      const number = Number(text.replace(",", "."));
      const fits =
        text !== "" &&
        Number.isFinite(number) &&
        (field.decimal || Number.isInteger(number)) &&
        number >= (field.min ?? -Infinity) &&
        number <= (field.max ?? Infinity);
      return fits ? { value: String(number) } : invalid;
    }
    case "date_input": {
      const date = new Date(`${text}T00:00:00Z`);
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(text) &&
        !Number.isNaN(date.getTime()) &&
        date.toISOString().startsWith(text);
      return valid ? { value: text } : invalid;
    }
    case "external_select": {
      const chosen = form.found && pick(form.found, text);
      if (chosen) return { value: chosen.value };
      return text.length >= (field.minQueryLength ?? 1)
        ? { search: text }
        : invalid;
    }
    default: {
      const chosen = pick(field.options, text);
      return chosen ? { value: chosen.value } : invalid;
    }
  }
}

export function flattenOptions(
  result: OptionsLoadResult | undefined,
): SelectOptionElement[] {
  return (result ?? []).flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
}

/**
 * The `form` items for the fields still to ask, when the website widget can
 * show every one: it requires every field, has no length limit for a text
 * area, and knows no numbers, dates or searches.
 */
export function formItemsOf(form: Form): ChatwootFormItem[] | undefined {
  const items = form.fields
    .filter(({ id }) => form.pending.includes(id))
    .map(itemOf);
  return items.every((item) => item !== undefined) ? items : undefined;
}

function itemOf(field: Field): ChatwootFormItem | undefined {
  const initial = initialOf(field);
  const base = {
    label: field.label,
    name: field.id,
    ...(initial ? { default: initial } : {}),
  };
  if (field.optional) return undefined;
  if (field.type === "text_input" && field.maxLength === undefined)
    return {
      ...base,
      type: field.multiline ? "text_area" : "text",
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    };
  if (field.type === "select" || field.type === "radio_select")
    return {
      ...base,
      type: "select",
      options: field.options.map(({ label, value }) => ({ label, value })),
    };
  return undefined;
}

/**
 * The values a native form came back with, or undefined unless they answer
 * exactly the fields it asked, with options it offered: a contact can patch
 * `submitted_values` through Chatwoot's public API.
 */
export function submittedOf(
  form: Form,
  submitted: unknown,
): Record<string, string> | undefined {
  if (!Array.isArray(submitted) || submitted.length !== form.pending.length)
    return undefined;
  const values = { ...form.values };
  for (const field of form.fields.filter(({ id }) =>
    form.pending.includes(id),
  )) {
    const value = submitted.find((entry) => entry?.name === field.id)?.value;
    const offered = optionsOf(field, form);
    if (
      typeof value !== "string" ||
      !value ||
      (offered && !offered.some((option) => option.value === value))
    )
      return undefined;
    values[field.id] = value;
  }
  return values;
}
