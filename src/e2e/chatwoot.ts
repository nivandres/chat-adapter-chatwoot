import http from "node:http";
import type { AddressInfo } from "node:net";

export const e2e = {
  url: process.env.CHATWOOT_E2E_URL,
  accountId: Number(process.env.CHATWOOT_E2E_ACCOUNT_ID),
  adminToken: process.env.CHATWOOT_E2E_ADMIN_TOKEN ?? "",
  agentToken: process.env.CHATWOOT_E2E_AGENT_TOKEN ?? "",
  agentId: Number(process.env.CHATWOOT_E2E_AGENT_ID),
  hookHost: process.env.CHATWOOT_E2E_HOOK_HOST ?? "host.docker.internal",
};

/** Chatwoot delivers through Sidekiq, which takes seconds on a cold container. */
export async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** An Application API client acting as an agent, outside the adapter under test. */
export function agentApi(token: string) {
  return async <T = any>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> => {
    const response = await fetch(
      `${e2e.url}/api/v1/accounts/${e2e.accountId}${path}`,
      {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          api_access_token: token,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** A contact writing in through an API inbox's public client API. */
export async function customer(inboxIdentifier: string, name: string) {
  const base = `${e2e.url}/public/api/v1/inboxes/${inboxIdentifier}`;
  const call = async <T = any>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const contact = await call<{ id: number; source_id: string }>(
    "/contacts",
    json({ name, email: `${crypto.randomUUID()}@e2e.test` }),
  );
  const conversation = await call<{ id: number; inbox_id: number }>(
    `/contacts/${contact.source_id}/conversations`,
    json({}),
  );
  const messages = `/contacts/${contact.source_id}/conversations/${conversation.id}/messages`;

  return {
    contactId: contact.id,
    conversationId: conversation.id,
    inboxId: conversation.inbox_id,
    say: (content: string) => call<{ id: number }>(messages, json({ content })),
    upload: (content: string, file: Blob, filename: string) => {
      const form = new FormData();
      form.append("content", content);
      form.append("attachments[]", file, filename);
      return call<{ id: number }>(messages, { method: "POST", body: form });
    },
    /** A click on an `input_select`, as the web widget sends it. */
    pick: (messageId: number, item: { title: string; value: string }) =>
      call(`${messages}/${messageId}`, {
        ...json({ submitted_values: [item] }),
        method: "PATCH",
      }),
    /** What the contact sees, which leaves out private notes. */
    transcript: () =>
      call<
        {
          id: number;
          content: string | null;
          message_type: number;
          content_attributes?: any;
          attachments?: any[];
        }[]
      >(messages),
  };
}

/** A visitor writing in through a website widget's own API, as the widget does. */
export async function visitor(websiteToken: string) {
  const base = `${e2e.url}/api/v1/widget`;
  const call = async <T = any>(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> => {
    const response = await fetch(
      `${base}${path}?website_token=${websiteToken}`,
      {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": init.token ?? "",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const { website_channel_config } = await call("/config", { method: "POST" });
  const token = website_channel_config.auth_token as string;

  return {
    say: (content: string) =>
      call<{ id: number; conversation_id: number; inbox_id: number }>(
        "/messages",
        { body: { message: { content } }, token },
      ),
    /** A filled-in `form` or a picked `input_select`, as the widget sends it. */
    submit: (messageId: number, values: unknown[]) =>
      call(`/messages/${messageId}`, {
        method: "PATCH",
        body: { message: { submitted_values: values } },
        token,
      }),
    /** What the visitor sees, which leaves out private notes. */
    transcript: async () =>
      (
        await call<{
          payload: {
            id: number;
            content: string | null;
            message_type: number;
            content_type: string;
            content_attributes?: any;
          }[];
        }>("/messages", { token })
      ).payload,
  };
}

export interface WebhookServer {
  /** The URL Chatwoot, inside Docker, posts to. */
  url: (path: string) => string;
  close: () => Promise<void>;
}

/** A real HTTP server on every interface, so the Chatwoot container can reach it. */
export async function serveWebhooks(
  handler: (request: Request) => Promise<Response>,
): Promise<WebhookServer> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(key, value);
    const response = await handler(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers,
        body: Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://${e2e.hookHost}:${port}${path}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
