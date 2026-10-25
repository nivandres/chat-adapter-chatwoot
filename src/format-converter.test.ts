import { describe, expect, it } from "vitest";
import { ChatwootFormatConverter, chatwootMention } from "./format-converter";

const converter = new ChatwootFormatConverter();

describe("ChatwootFormatConverter", () => {
  describe("toAst", () => {
    it("parses plain text", () => {
      expect(converter.toAst("Hello world").type).toBe("root");
    });

    it("parses bold, italic, strikethrough and code", () => {
      const ast = converter.toAst("**bold** _italic_ ~~gone~~ `code`");
      const paragraph = ast.children[0];
      const types =
        "children" in paragraph
          ? paragraph.children.map((node) => node.type)
          : [];

      expect(types).toContain("strong");
      expect(types).toContain("emphasis");
      expect(types).toContain("delete");
      expect(types).toContain("inlineCode");
    });

    it("parses a mention as a link", () => {
      const ast = converter.toAst("[@Bruce](mention://user/30/Bruce)");
      const paragraph = ast.children[0];
      const link = "children" in paragraph ? paragraph.children[0] : undefined;

      expect(link).toMatchObject({
        type: "link",
        url: "mention://user/30/Bruce",
      });
    });
  });

  describe("fromAst", () => {
    it("roundtrips markdown", () => {
      expect(converter.fromAst(converter.toAst("**bold**"))).toContain(
        "**bold**",
      );
    });

    it("roundtrips lists and code blocks", () => {
      const rendered = converter.fromAst(
        converter.toAst("- one\n- two\n\n```js\nconst a = 1;\n```"),
      );

      expect(rendered).toContain("one");
      expect(rendered).toContain("```js");
    });
  });

  describe("extractPlainText", () => {
    it("strips every marker", () => {
      expect(
        converter.extractPlainText(
          "**bold** [@Bruce](mention://user/30/Bruce)",
        ),
      ).toBe("bold @Bruce");
    });
  });

  describe("renderPostable", () => {
    it("passes raw strings through untouched", () => {
      expect(converter.renderPostable("Hello **world**")).toBe(
        "Hello **world**",
      );
    });

    it("renders a card as fallback text", () => {
      const rendered = converter.renderPostable({
        card: { type: "card", title: "Test Card", children: [] },
      });

      expect(rendered).toContain("Test Card");
    });
  });
});

describe("chatwootMention", () => {
  it("builds the markdown Chatwoot parses as a mention", () => {
    expect(chatwootMention(30, "Bruce")).toBe(
      "[@Bruce](mention://user/30/Bruce)",
    );
  });

  it("encodes names and supports teams", () => {
    expect(chatwootMention(4, "Support Team", "team")).toBe(
      "[@Support Team](mention://team/4/Support%20Team)",
    );
  });
});
