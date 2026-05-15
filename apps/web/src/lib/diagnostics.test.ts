import { describe, expect, test } from "bun:test";
import { scrubPii } from "./diagnostics";

describe("scrubPii", () => {
  test("redacts phone numbers", () => {
    expect(scrubPii("called +27 82 123 4567 today")).toContain("[phone]");
    expect(scrubPii("called +27 82 123 4567 today")).not.toContain("4567");
  });

  test("redacts email addresses", () => {
    expect(scrubPii("alert pho3nix066@gmail.com")).toContain("[email]");
    expect(scrubPii("alert pho3nix066@gmail.com")).not.toContain("pho3nix066");
  });

  test("redacts long hex strings (session blobs)", () => {
    const hex = "a".repeat(48);
    expect(scrubPii(`session=${hex}`)).toContain("[hex]");
  });

  test("redacts Bearer tokens", () => {
    expect(scrubPii("Authorization: Bearer abc.def.ghi")).toContain("Bearer [token]");
  });

  test("redacts sessionId / password / apiHash JSON fields", () => {
    const json = '{"sessionId":"xyz","password":"hunter2","apiHash":"ahash"}';
    const scrubbed = scrubPii(json);
    expect(scrubbed).not.toContain("xyz");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("ahash");
    expect(scrubbed).toContain("[redacted]");
  });
});
