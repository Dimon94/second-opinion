import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

interface HandoffFixture {
  name: string;
  doctor: {
    outcome: string;
    reason: string;
    nextAction: { type: string; [key: string]: unknown };
  };
  policy: {
    browser: string;
    pause: string;
    pairing: string;
    after: string;
  };
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function handoffRows(markdown: string): Map<string, HandoffFixture["policy"]> {
  const rows = new Map<string, HandoffFixture["policy"]>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const [action, browser, pause, pairing, after] = line
      .split("|")
      .slice(1, -1)
      .map((value) => value.trim().replaceAll("`", ""));
    rows.set(action, { browser, pause, pairing, after });
  }
  return rows;
}

describe("setup and run Skill doctor handoff", () => {
  const fixtures = JSON.parse(read("tests/fixtures/skill-handoff.json")) as HandoffFixture[];

  it("shares one golden policy for every nextAction", () => {
    const shared = read("skill/DOCTOR-HANDOFF.md");
    const setup = read("skill/SKILL.md");
    const run = read("skill-run/SKILL.md");
    const rows = handoffRows(shared);

    expect([...rows.keys()]).toEqual(fixtures.map((fixture) => fixture.doctor.nextAction.type));
    for (const fixture of fixtures) {
      expect(Object.keys(fixture.doctor).sort(), fixture.name).toEqual([
        "nextAction",
        "outcome",
        "reason",
      ]);
      expect(rows.get(fixture.doctor.nextAction.type), fixture.name).toEqual(fixture.policy);
    }
    expect(setup).toContain("skill/DOCTOR-HANDOFF.md");
    expect(run).toContain("skill/DOCTOR-HANDOFF.md");
  });

  it("creates pairing only in the OAuth action and resumes with the same workspace", () => {
    const shared = read("skill/DOCTOR-HANDOFF.md");
    const setup = read("skill/SKILL.md");
    const run = read("skill-run/SKILL.md");

    expect(shared.match(/c2c pair/g)).toHaveLength(1);
    expect(shared).toMatch(/authorize_oauth.*c2c pair/);
    expect(shared).toContain("c2c doctor -w <same-workspace> --json");
    expect(shared).toContain("c2c tunnel login --force --json");
    expect(shared).toContain("--browser-gate chatgpt_login");
    expect(shared).toContain("built-in browser only");
    expect(shared).toContain("MFA, CAPTCHA");
    expect(shared).toContain("Never use Reconnect");
    expect(shared).toMatch(/no\s+supported Connector CRUD API/);
    expect(setup).not.toMatch(/chatgptRepair|namedRepair|report\.bridge|c2c pair/);
    expect(run).not.toMatch(/chatgptRepair|namedRepair|report\.bridge|c2c pair/);
  });

  it("does not treat a green local outcome as completion while a remote action remains", () => {
    const localGreen = fixtures.filter((fixture) =>
      ["healthy", "repaired"].includes(fixture.doctor.outcome)
    );
    expect(localGreen.map((fixture) => fixture.doctor.nextAction.type)).toEqual([
      "none",
      "open_conversation",
      "create_conversation",
    ]);
    expect(read("skill/DOCTOR-HANDOFF.md")).toContain(
      "A green local outcome does not cancel nextAction"
    );
  });

  it("binds the host workspace before the production Connector reads it", () => {
    const shared = read("skill/DOCTOR-HANDOFF.md");
    const setup = read("skill/SKILL.md");
    const run = read("skill-run/SKILL.md");
    const protocol = read("docs/protocol.md");

    expect(shared).toContain("/mcp/session");
    expect(shared).toContain("never retry through the legacy `/mcp`");
    expect(setup).toContain("c2c binding bootstrap -w <current-project-root>");
    expect(run).toContain("c2c binding bootstrap -w <current-project-root>");
    expect(setup).toContain("c2c binding unbind --task <SETUP_TASK_ID>");
    expect(run).toContain("c2c binding unbind --task <TASK_ID>");
    expect(protocol).toContain("WORKSPACE_BOOTSTRAP:");
    expect(protocol).toContain("include it in every workspace_info and read_file call");
  });
});
