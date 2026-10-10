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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("rejects an absolute off-origin endpoint, even over https", () => {
    // Two reasons, both landing on the student rather than the deployer:
    // `_headers` ships `connect-src 'self' https://*.supabase.co`, so the
    // browser blocks it and the tab renders a chat that cannot send; and the
    // Bearer header carries the student's Supabase access token, which an
    // off-origin endpoint would receive. Front a remote proxy at your own
    // origin instead.
    expect(parseChatEndpoint("https://api.example.com/v1/chat")).toBeNull();
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

  it("rejects an endpoint the shipped CSP would block", () => {
    // Keep this honest against the real header rather than a remembered one.
    const headers = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "_headers"),
      "utf-8",
    );
    // The real directive line, not the prose above it -- an unanchored match
    // found "connect-src covers same-origin /v1 and" in the file's comment
    // and asserted against a sentence.
    const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1] ?? "";
    expect(csp, "no Content-Security-Policy header in public/_headers").not.toBe("");
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(connect, "the CSP no longer restricts connect-src").toContain("'self'");
    // Any host we would accept must be reachable under that policy. Today the
    // only accepted absolute forms are localhost, which no deployed CSP sees.
    expect(parseChatEndpoint("https://elsewhere.example/v1/chat")).toBeNull();
  });

  it("rejects something that is not a URL or a path at all", () => {
    expect(parseChatEndpoint("yes")).toBeNull();
    expect(parseChatEndpoint("true")).toBeNull();
    expect(parseChatEndpoint("v1/chat")).toBeNull(); // relative, no leading slash
  });
});
