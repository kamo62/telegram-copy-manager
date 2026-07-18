import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveStaticAssets, createApi } from "./app";

describe("deployment configuration", () => {
  test("keeps the app container restartable after host reboots", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");

    expect(compose).toMatch(/^\s{2}app:\n(?:^\s{4}.+\n)*^\s{4}restart:\s+unless-stopped$/m);
  });

  test("archives the outgoing container assets before replacing it", () => {
    const deploy = readFileSync("scripts/deploy.sh", "utf8");
    const archiveAt = deploy.indexOf("/app/data/asset-archive/assets");
    const removeAt = deploy.indexOf("docker rm -f");

    expect(archiveAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(archiveAt);
  });

  test("serves an old hashed asset from the persistent archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-tc-assets-"));
    const staticRoot = join(root, "dist");
    const archiveRoot = join(root, "asset-archive");
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    mkdirSync(join(archiveRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<main>app</main>");
    writeFileSync(join(staticRoot, "assets", "index-current.js"), "current");
    writeFileSync(join(archiveRoot, "assets", "index-old.js"), "old");

    try {
      const result = archiveStaticAssets(staticRoot, archiveRoot, 2);
      const app = createApi({
        assetArchiveRoot: archiveRoot,
        databasePath: ":memory:",
        staticRoot,
      });
      const response = await app.request("/assets/index-old.js");

      expect(result).toEqual({ archived: 1, pruned: 0, retained: 2 });
      expect(await response.text()).toBe("old");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      await app.stopTelegramIngestion();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("prunes the oldest archived assets to the retention cap", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-tc-assets-"));
    const staticRoot = join(root, "dist");
    const archiveRoot = join(root, "asset-archive");
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    mkdirSync(join(archiveRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "assets", "current.js"), "current");
    writeFileSync(join(archiveRoot, "assets", "old-a.js"), "old-a");
    writeFileSync(join(archiveRoot, "assets", "old-b.js"), "old-b");

    try {
      const result = archiveStaticAssets(staticRoot, archiveRoot, 2);

      expect(result).toEqual({ archived: 1, pruned: 1, retained: 2 });
      expect(existsSync(join(archiveRoot, "assets", "current.js"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
