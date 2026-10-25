import {
  BaseFormatConverter,
  parseMarkdown,
  stringifyMarkdown,
  type Root,
} from "chat";

/**
 * Chatwoot stores message content as CommonMark and renders it per channel, so
 * the canonical mdast maps straight onto it in both directions.
 */
export class ChatwootFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast);
  }
}

/**
 * Build the markdown link Chatwoot recognises as a mention.
 *
 * Chatwoot only notifies mentions found in private notes, so pass the result to
 * {@link ChatwootAdapter.postPrivateNote} rather than to a reply.
 *
 * @example
 * ```typescript
 * await chatwoot.postPrivateNote(threadId, `${chatwootMention(30, "Bruce")} take a look`);
 * ```
 */
export function chatwootMention(
  id: number,
  name: string,
  type: "user" | "team" = "user",
): string {
  return `[@${name}](mention://${type}/${id}/${encodeURIComponent(name)})`;
}
