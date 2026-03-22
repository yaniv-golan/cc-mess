import { describe, it, expect } from "vitest";
import {
  getNamePool,
  generateHexSuffix,
  allocateName,
  resolveShortName,
} from "../../src/names.js";
import type { Registry, InstanceEntry } from "../../src/types.js";

function makeEntry(
  overrides: Partial<InstanceEntry> = {},
): InstanceEntry {
  return {
    pid: 1,
    cwd: "/tmp",
    name: "test",
    role: "worker",
    capabilities: [],
    spawned_by: null,
    depth: 0,
    task: "test",
    alive_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    paused: false,
    ...overrides,
  };
}

describe("names", () => {
  describe("getNamePool", () => {
    it("returns a pool of at least 200 names", () => {
      const pool = getNamePool();
      expect(pool.length).toBeGreaterThanOrEqual(200);
    });

    it("contains only lowercase strings", () => {
      const pool = getNamePool();
      for (const name of pool) {
        expect(name).toBe(name.toLowerCase());
      }
    });

    it("has no duplicate names", () => {
      const pool = getNamePool();
      const unique = new Set(pool);
      expect(unique.size).toBe(pool.length);
    });
  });

  describe("generateHexSuffix", () => {
    it("returns a 4-character hex string", () => {
      const suffix = generateHexSuffix();
      expect(suffix).toMatch(/^[0-9a-f]{4}$/);
    });

    it("generates different suffixes on repeated calls", () => {
      const suffixes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        suffixes.add(generateHexSuffix());
      }
      expect(suffixes.size).toBeGreaterThan(1);
    });
  });

  describe("allocateName", () => {
    it("returns a name and fullId from the pool", () => {
      const registry: Registry = { instances: {} };
      const result = allocateName(registry);
      expect(result.name).toBeTruthy();
      expect(result.fullId).toContain(result.name);
      expect(result.fullId).toMatch(/-[0-9a-f]{4}$/);
      expect(getNamePool()).toContain(result.name);
    });

    it("avoids names already in use", () => {
      const pool = getNamePool();
      const registry: Registry = { instances: {} };

      for (let i = 0; i < pool.length - 1; i++) {
        registry.instances[`${pool[i]}-0000`] = makeEntry({
          name: pool[i],
        });
      }

      const result = allocateName(registry);
      expect(result.name).toBe(pool[pool.length - 1]);
    });

    it("throws when all names are exhausted", () => {
      const pool = getNamePool();
      const registry: Registry = { instances: {} };
      for (const name of pool) {
        registry.instances[`${name}-0000`] = makeEntry({
          name,
        });
      }
      expect(() => allocateName(registry)).toThrow(
        "Name pool exhausted",
      );
    });
  });

  describe("resolveShortName", () => {
    it("resolves a short name to the full ID", () => {
      const registry: Registry = {
        instances: {
          "apollo-3f2a": makeEntry({ name: "apollo" }),
        },
      };
      expect(resolveShortName(registry, "apollo")).toBe(
        "apollo-3f2a",
      );
    });

    it("resolves a full ID directly", () => {
      const registry: Registry = {
        instances: {
          "apollo-3f2a": makeEntry({ name: "apollo" }),
        },
      };
      expect(
        resolveShortName(registry, "apollo-3f2a"),
      ).toBe("apollo-3f2a");
    });

    it("throws on unknown name", () => {
      const registry: Registry = { instances: {} };
      expect(() =>
        resolveShortName(registry, "unknown"),
      ).toThrow('No instance found with name "unknown"');
    });

    it("throws on ambiguous short name", () => {
      const registry: Registry = {
        instances: {
          "apollo-3f2a": makeEntry({ name: "apollo" }),
          "apollo-9d4e": makeEntry({ name: "apollo" }),
        },
      };
      expect(() =>
        resolveShortName(registry, "apollo"),
      ).toThrow("Ambiguous name");
    });
  });
});
