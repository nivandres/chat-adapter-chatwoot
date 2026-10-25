import {
  chartElementToFallbackText,
  tableElementToAscii,
  type CardChild,
  type CardElement,
  type LinkButtonElement,
} from "chat";

/**
 * Chatwoot `input_select` items carry a single opaque `value`, so the action ID
 * and the button value share it. A value may contain newlines, so only the
 * first delimiter separates the two halves.
 */
const DELIMITER = "\n";

/** An `input_select` item in a message's `content_attributes.items` */
export interface ChatwootSelectItem {
  /** Label shown on the option */
  title: string;
  /** Opaque value echoed back in `content_attributes.submitted_values` */
  value: string;
}

/** A card rendered into what Chatwoot's message API accepts */
export interface ChatwootCard {
  /** Markdown body of the message */
  content: string;
  /** Options to send as `input_select` items, empty when the card has no buttons or selects */
  items: ChatwootSelectItem[];
  /** Image URLs to send as attachments of the same message, the header image first */
  images: string[];
}

export function encodeActionValue(actionId: string, value?: string): string {
  return value ? `${actionId}${DELIMITER}${value}` : actionId;
}

export function decodeActionValue(encoded: string): {
  actionId: string;
  value?: string;
} {
  const separator = encoded.indexOf(DELIMITER);
  if (separator === -1) return { actionId: encoded };
  return {
    actionId: encoded.slice(0, separator),
    value: encoded.slice(separator + 1),
  };
}

/**
 * Render a card as Chatwoot content.
 *
 * Buttons and select options become `input_select` items, the only
 * interactive content Chatwoot patches back onto the message: a web widget
 * click sets `content_attributes.submitted_values` and fires
 * `message_updated`. Chatwoot also renders the same items as native WhatsApp
 * buttons, but maps a WhatsApp reply back to the button's title, so those
 * arrive as an incoming message instead. Link buttons have no place in a
 * select item, so they render as markdown links, and images go out as
 * attachments, which every inbox delivers.
 */
export function renderCard(card: CardElement): ChatwootCard {
  const actions = collectActions(card.children);
  return {
    content: [
      cardToText(card),
      actions
        .flatMap((action) =>
          action.type === "select" || action.type === "radio_select"
            ? [`**${action.label}**`]
            : [],
        )
        .join("\n"),
      actions
        .filter(isLinkButton)
        .map((button) => `[${button.label}](${button.url})`)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n\n"),
    items: actions.flatMap((action) => {
      if (action.type === "button")
        return action.disabled
          ? []
          : [
              {
                title: action.label,
                value: encodeActionValue(action.id, action.value),
              },
            ];
      if (action.type === "link-button") return [];
      return action.options.map((option) => ({
        title: option.label,
        value: encodeActionValue(action.id, option.value),
      }));
    }),
    images: [
      ...(card.imageUrl ? [card.imageUrl] : []),
      ...collectImages(card.children),
    ],
  };
}

/** A card's text in Markdown. Its images and actions are rendered apart. */
export function cardToText(card: CardElement): string {
  return [
    card.title && `**${card.title}**`,
    card.subtitle,
    ...card.children.map(childText),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function childText(child: CardChild): string {
  switch (child.type) {
    case "text":
      return child.style === "bold"
        ? `**${child.content}**`
        : child.style === "muted"
          ? `_${child.content}_`
          : child.content;
    case "link":
      return `[${child.label}](${child.url})`;
    case "fields":
      return child.children
        .map(({ label, value }) => `**${label}:** ${value}`)
        .join("\n");
    case "table":
      return `\`\`\`\n${tableElementToAscii(child.headers, child.rows)}\n\`\`\``;
    case "chart":
      return chartElementToFallbackText(child);
    case "section":
      return child.children.map(childText).filter(Boolean).join("\n\n");
    case "divider":
      return "---";
    default:
      return "";
  }
}

function isLinkButton(action: { type: string }): action is LinkButtonElement {
  return action.type === "link-button";
}

function collectActions(children: CardChild[]): ActionsElementChild[] {
  return children.flatMap((child) => {
    if (child.type === "actions") return child.children;
    if (child.type === "section") return collectActions(child.children);
    return [];
  });
}

function collectImages(children: CardChild[]): string[] {
  return children.flatMap((child) => {
    if (child.type === "image") return [child.url];
    if (child.type === "section") return collectImages(child.children);
    return [];
  });
}

type ActionsElementChild = Extract<
  CardChild,
  { type: "actions" }
>["children"][number];
