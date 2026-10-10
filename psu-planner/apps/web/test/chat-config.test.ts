/** Whether the advisor is configured at all.
 *
 * The project's stated model is bring-your-own-AI: a default install costs
 * the project nothing and a fork cannot spend someone else's money. That only
 * holds if the client has no endpoint baked into it and the UI never offers a
 * control that cannot work.
 *
 * This mirrors how account sync already behaves (`sync.ts`), including its
 * lesson: that gate originally tested PRESENCE only, so a placeholder left in
 * .env.local passed it and the app crashed. Shape is validated here too. */
import { describe, it, expect } from "vitest";
import { parseChatEndpoint } from "../src/chat/config";

describe("with nothing configured", () => {
  it("is not configured", () => {
    expect(parseChatEndpoint(undefined)).toBeNull();
    expect(parseChatEndpoint("")).toBeNull();
    expect(parseChatEndpoint("   ")).toBeNull();
  });
});

describe("a configured endpoint", () => {
  it("accepts a same-origin path, which is what a self-hoster running the Pages Function sets", () => {
    expect(parseChatEndpoint("/v1/chat")).toBe("/v1/chat");
  });

  it("accepts an absolute https endpoint, for a proxy hosted elsewhere", () => {
    expect(parseChatEndpoint("https://api.example.com/v1/chat")).toBe("https://api.example.com/v1/chat");
  });

  it("allows http only on localhost, where there is no network to sniff", () => {
    expect(parseChatEndpoint("http://localhost:8787/v1/chat")).toBe("http://localhost:8787/v1/chat");
    expect(parseChatEndpoint("http://127.0.0.1:8787/v1/chat")).toBe("http://127.0.0.1:8787/v1/chat");
  });

  it("trims surrounding whitespace, which a pasted value carries", () => {
    expect(parseChatEndpoint("  /v1/chat  ")).toBe("/v1/chat");
  });
});

describe("a value that cannot work", () => {
  /** Degrade to "not configured" rather than ship a control that fails when
   * pressed. Same rule as sync.ts: the conservative failure is local-only. */
  it("rejects a placeholder left in the env file", () => {
    expect(parseChatEndpoint("<your-endpoint>")).toBeNull();
    expect(parseChatEndpoint("https://<host>/v1/chat")).toBeNull();
  });

  it("rejects plain http to a real host, which a browser would block as mixed content", () => {
    expect(parseChatEndpoint("http://api.example.com/v1/chat")).toBeNull();
  });

  it("rejects something that is not a URL or a path at all", () => {
    expect(parseChatEndpoint("yes")).toBeNull();
    expect(parseChatEndpoint("true")).toBeNull();
    expect(parseChatEndpoint("v1/chat")).toBeNull(); // relative, no leading slash
  });
});
