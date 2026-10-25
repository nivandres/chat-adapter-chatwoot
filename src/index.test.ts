import { describe, expect, it } from "vitest";
import * as chatwoot from "./index";

describe("package exports", () => {
  it("exports the adapter, factory, converter and guards", () => {
    expect(typeof chatwoot.ChatwootAdapter).toBe("function");
    expect(typeof chatwoot.createChatwootAdapter).toBe("function");
    expect(typeof chatwoot.ChatwootFormatConverter).toBe("function");
    expect(typeof chatwoot.chatwootMention).toBe("function");
    expect(typeof chatwoot.isChatwootAdapter).toBe("function");
    expect(typeof chatwoot.requireChatwootAdapter).toBe("function");
  });

  it("exports the schemas and enum tables", () => {
    expect(chatwoot.CHATWOOT_MESSAGE_TYPES).toEqual([
      "incoming",
      "outgoing",
      "activity",
      "template",
    ]);
    expect(typeof chatwoot.ChatwootWebhookPayloadSchema.safeParse).toBe(
      "function",
    );
    expect(chatwoot.CHATWOOT_WEBHOOK_EVENTS).toContain("message_created");
    expect(chatwoot.ChatwootErrorCode.REQUEST_FAILED).toBe("REQUEST_FAILED");
  });

  it("narrows an adapter with the guards", () => {
    const adapter = chatwoot.createChatwootAdapter({
      accessToken: "t",
      accountId: 1,
    });

    expect(chatwoot.isChatwootAdapter(adapter)).toBe(true);
    expect(chatwoot.isChatwootAdapter({})).toBe(false);
    expect(chatwoot.requireChatwootAdapter({ adapter })).toBe(adapter);
    expect(() => chatwoot.requireChatwootAdapter({})).toThrow();
  });
});
