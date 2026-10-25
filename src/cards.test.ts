import { Card } from "chat";
import { describe, expect, it } from "vitest";
import { decodeActionValue, encodeActionValue, renderCard } from "./cards";

describe("renderCard", () => {
  it("renders title, styled text, fields and a monospaced table as markdown", () => {
    const { content, items } = renderCard(
      Card({
        title: "Order 42",
        subtitle: "Pending",
        children: [
          { type: "text", content: "Approve this order?" },
          { type: "text", content: "Due today", style: "bold" },
          { type: "text", content: "Sent by Ada", style: "muted" },
          {
            type: "fields",
            children: [{ type: "field", label: "Total", value: "$20" }],
          },
          { type: "table", headers: ["Item", "Qty"], rows: [["Tea", "2"]] },
          { type: "divider" },
          {
            type: "section",
            children: [
              { type: "link", label: "Track", url: "https://example.com/t" },
            ],
          },
        ],
      }),
    );

    expect(content).toContain("**Order 42**\n\nPending");
    expect(content).toContain("**Due today**");
    expect(content).toContain("_Sent by Ada_");
    expect(content).toContain("**Total:** $20");
    expect(content).toMatch(/```\nItem +\| Qty\n[-|+ ]+\nTea +\| 2\n```/);
    expect(content).toContain("---\n\n[Track](https://example.com/t)");
    expect(items).toEqual([]);
  });

  it("turns buttons into select items and link buttons into markdown links", () => {
    const { content, items } = renderCard(
      Card({
        children: [
          {
            type: "actions",
            children: [
              { type: "button", id: "approve", label: "Approve", value: "42" },
              { type: "button", id: "reject", label: "Reject" },
              { type: "button", id: "gone", label: "Gone", disabled: true },
              {
                type: "link-button",
                label: "Open",
                url: "https://example.com/42",
              },
            ],
          },
        ],
      }),
    );

    expect(items).toEqual([
      { title: "Approve", value: "approve\n42" },
      { title: "Reject", value: "reject" },
    ]);
    expect(content).toContain("[Open](https://example.com/42)");
  });

  it("finds buttons nested inside sections", () => {
    const { items } = renderCard(
      Card({
        children: [
          {
            type: "section",
            children: [
              {
                type: "actions",
                children: [{ type: "button", id: "deep", label: "Deep" }],
              },
            ],
          },
        ],
      }),
    );

    expect(items).toEqual([{ title: "Deep", value: "deep" }]);
  });

  it("turns a select's options into select items under its label", () => {
    const { content, items } = renderCard(
      Card({
        children: [
          {
            type: "actions",
            children: [
              {
                type: "select",
                id: "size",
                label: "Size",
                options: [
                  { label: "Small", value: "s" },
                  { label: "Large", value: "l" },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(content).toBe("**Size**");
    expect(items).toEqual([
      { title: "Small", value: "size\ns" },
      { title: "Large", value: "size\nl" },
    ]);
  });

  it("leaves the header image and image children to attachments", () => {
    const { content, images } = renderCard(
      Card({
        imageUrl: "https://img.example.com/header.png",
        children: [
          {
            type: "image",
            url: "https://img.example.com/body.png",
            alt: "body",
          },
        ],
      }),
    );

    expect(content).toBe("");
    expect(images).toEqual([
      "https://img.example.com/header.png",
      "https://img.example.com/body.png",
    ]);
  });
});

describe("action values", () => {
  it("omits the delimiter when there is no value", () => {
    expect(encodeActionValue("approve")).toBe("approve");
    expect(encodeActionValue("approve", "")).toBe("approve");
  });

  it("roundtrips a Chat SDK callback token", () => {
    const token = `__cb:${"a".repeat(16)}`;
    expect(decodeActionValue(encodeActionValue("approve", token))).toEqual({
      actionId: "approve",
      value: token,
    });
  });
});
