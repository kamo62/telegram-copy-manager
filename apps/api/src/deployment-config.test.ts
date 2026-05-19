import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("deployment configuration", () => {
  test("keeps the app container restartable after host reboots", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");

    expect(compose).toMatch(/^\s{2}app:\n(?:^\s{4}.+\n)*^\s{4}restart:\s+unless-stopped$/m);
  });
});
