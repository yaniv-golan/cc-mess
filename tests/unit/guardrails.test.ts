import { describe, it, expect } from "vitest";
import {
  createStrictProfile,
  createPermissiveProfile,
  createCustomProfile,
  getProfile,
  isPathWithinCwd,
  checkBashCommand,
  checkToolAccess,
  generateGuardrailScript,
} from "../../src/guardrails.js";

const TEST_CWD = "/tmp/cc-mess-test-cwd";

describe("guardrails", () => {
  describe("createStrictProfile", () => {
    it("returns a strict profile", () => {
      const p = createStrictProfile(TEST_CWD);
      expect(p.name).toBe("strict");

      const writePolicy = p.policies.find(
        (pol) => pol.tool === "Write",
      );
      expect(writePolicy?.action).toBe("block");

      const readPolicy = p.policies.find(
        (pol) => pol.tool === "Read",
      );
      expect(readPolicy?.action).toBe("allow");

      const spawnPolicy = p.policies.find(
        (pol) => pol.tool === "spawn",
      );
      expect(spawnPolicy?.action).toBe("block");
    });

    it("limits broadcast to insight only", () => {
      const p = createStrictProfile(TEST_CWD);
      const broadcastPolicy = p.policies.find(
        (pol) => pol.tool === "broadcast",
      );
      expect(broadcastPolicy?.action).toBe("allow");
      expect(
        broadcastPolicy?.conditions?.allowed_types,
      ).toEqual(["insight"]);
    });
  });

  describe("createPermissiveProfile", () => {
    it("allows writes within cwd", () => {
      const p = createPermissiveProfile(TEST_CWD);
      expect(p.name).toBe("permissive");

      const writePolicy = p.policies.find(
        (pol) => pol.tool === "Write",
      );
      expect(writePolicy?.action).toBe("allow");
      expect(writePolicy?.conditions?.within_cwd).toBe(
        TEST_CWD,
      );
    });

    it("blocks git push via Bash", () => {
      const p = createPermissiveProfile(TEST_CWD);
      const bashPolicy = p.policies.find(
        (pol) => pol.tool === "Bash",
      );
      expect(
        bashPolicy?.conditions?.blocked_commands,
      ).toContain("git push");
    });

    it("allows spawn", () => {
      const p = createPermissiveProfile(TEST_CWD);
      const spawnPolicy = p.policies.find(
        (pol) => pol.tool === "spawn",
      );
      expect(spawnPolicy?.action).toBe("allow");
    });
  });

  describe("createCustomProfile", () => {
    it("accepts inline policies", () => {
      const p = createCustomProfile([
        { tool: "Read", action: "allow" },
        {
          tool: "Write",
          action: "block",
          message: "No writes",
        },
      ]);
      expect(p.name).toBe("custom");
      expect(p.policies).toHaveLength(2);
    });
  });

  describe("getProfile", () => {
    it("returns strict for 'strict'", () => {
      const p = getProfile("strict", TEST_CWD);
      expect(p.name).toBe("strict");
    });

    it("returns permissive for 'permissive'", () => {
      const p = getProfile("permissive", TEST_CWD);
      expect(p.name).toBe("permissive");
    });

    it("returns custom for 'custom'", () => {
      const p = getProfile("custom", TEST_CWD, [
        { tool: "Read", action: "allow" },
      ]);
      expect(p.name).toBe("custom");
    });
  });

  describe("isPathWithinCwd", () => {
    it("allows paths within cwd", () => {
      expect(
        isPathWithinCwd("/tmp/foo/bar", "/tmp/foo"),
      ).toBe(true);
    });

    it("allows cwd itself", () => {
      expect(isPathWithinCwd("/tmp/foo", "/tmp/foo")).toBe(
        true,
      );
    });

    it("blocks paths outside cwd", () => {
      expect(
        isPathWithinCwd("/etc/passwd", "/tmp/foo"),
      ).toBe(false);
    });

    it("blocks traversal attacks", () => {
      expect(
        isPathWithinCwd(
          "/tmp/foo/../../etc/passwd",
          "/tmp/foo",
        ),
      ).toBe(false);
    });
  });

  describe("checkBashCommand", () => {
    it("allows listed commands in strict", () => {
      const p = createStrictProfile(TEST_CWD);
      expect(
        checkBashCommand("ls -la", p, TEST_CWD).allowed,
      ).toBe(true);
      expect(
        checkBashCommand("git log", p, TEST_CWD).allowed,
      ).toBe(true);
      expect(
        checkBashCommand(
          "git diff --staged",
          p,
          TEST_CWD,
        ).allowed,
      ).toBe(true);
    });

    it("blocks unlisted commands in strict", () => {
      const p = createStrictProfile(TEST_CWD);
      expect(
        checkBashCommand("rm -rf /", p, TEST_CWD).allowed,
      ).toBe(false);
      expect(
        checkBashCommand("curl http://x", p, TEST_CWD)
          .allowed,
      ).toBe(false);
    });

    it("blocks git push in permissive", () => {
      const p = createPermissiveProfile(TEST_CWD);
      expect(
        checkBashCommand("git push origin", p, TEST_CWD)
          .allowed,
      ).toBe(false);
    });
  });

  describe("checkToolAccess", () => {
    it("blocks Write in strict mode", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "Write",
        { path: `${TEST_CWD}/file.txt` },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });

    it("allows Read in strict mode within cwd", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "Read",
        { path: `${TEST_CWD}/file.txt` },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(true);
    });

    it("blocks Read outside cwd in strict mode", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "Read",
        { path: "/etc/passwd" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks unknown tools", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "UnknownTool",
        {},
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks restricted broadcast type in strict", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "broadcast",
        { type: "announcement" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });

    it("allows insight broadcast in strict", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "broadcast",
        { type: "insight" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(true);
    });

    it("blocks WebFetch in strict", () => {
      const p = createStrictProfile(TEST_CWD);
      const result = checkToolAccess(
        "WebFetch",
        { url: "https://example.com" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });

    it("allows npmjs in permissive WebFetch", () => {
      const p = createPermissiveProfile(TEST_CWD);
      const result = checkToolAccess(
        "WebFetch",
        { url: "https://registry.npmjs.org/express" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(true);
    });

    it("blocks non-registry URLs in permissive WebFetch", () => {
      const p = createPermissiveProfile(TEST_CWD);
      const result = checkToolAccess(
        "WebFetch",
        { url: "https://evil.com/data" },
        p,
        TEST_CWD,
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("generateGuardrailScript", () => {
    it("generates a valid bash script", () => {
      const p = createStrictProfile(TEST_CWD);
      const script = generateGuardrailScript(p, TEST_CWD);
      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain("jq");
      expect(script).toContain("exit 0");
      expect(script).toContain("exit 2");
    });
  });
});
