import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../skills/second-opinion/", import.meta.url));

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

it("ships a portable Skill with all local reference targets", () => {
  expect(fs.existsSync(path.join(root, "SKILL.md"))).toBe(true);
  for (const file of files(root)) {
    const content = fs.readFileSync(file, "utf8");
    expect(content, file).not.toMatch(/\/Users\/|\/home\/[^/\s]+\/|asdk_app_[a-f0-9]{16,}/);
    if (!file.endsWith(".md")) continue;
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:\/\//i.test(target)) continue;
      expect(fs.existsSync(path.resolve(path.dirname(file), target)), file + ": " + target).toBe(true);
    }
  }
});
