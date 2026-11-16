import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Instance, openInstance } from "../src/instance.ts";
import { sharedAcrossTests, tempDir, track } from "./helpers.ts";

// These tests are about the cleanup the other tests rely on: nothing is left
// behind, and no folder is removed while a database is still open in it.
// Several of them look at what the cleanup did after the tests before them,
// so the order of the tests in this file matters.

/** Opens a real Home Base in `dir`. Its `close` notes whether the folder was still on disk at that moment. */
async function openNoting(dir: string, name: string, notes: string[]): Promise<Instance> {
  const instance = await openInstance({ dataDir: dir });
  return {
    ...instance,
    close() {
      notes.push(`${name} closed, folder ${existsSync(instance.paths.dbFile) ? "still there" : "already gone"}`);
      instance.close();
    },
  };
}

function refusal(action: () => unknown): string {
  try {
    action();
    return "not refused";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("what one test opens", () => {
  const notes: string[] = [];
  let dir = "";

  it("gets a folder of its own", async () => {
    dir = tempDir();
    const instance = track(await openNoting(dir, "database", notes));
    expect(existsSync(instance.paths.dbFile)).toBe(true);
  });

  it("is closed and then removed as soon as that test is over", () => {
    expect(notes).toEqual(["database closed, folder still there"]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("what a group of tests shares", () => {
  const notes: string[] = [];
  let dir = "";

  describe("while the group runs", () => {
    const shared = sharedAcrossTests();
    let instance: Instance;

    /** Notes something that takes a moment to finish, as closing a Fastify server does. */
    async function noteLater(what: string): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      notes.push(`${what}, folder ${existsSync(instance.paths.dbFile) ? "still there" : "already gone"}`);
    }

    beforeAll(async () => {
      dir = shared.tempDir();
      instance = shared.track(await openNoting(dir, "database", notes));
      shared.track({ close: () => noteLater("server closed") });
      // What a group tears down by itself comes before all of that.
      return () => noteLater("the group's own cleanup ran");
    });

    it("is there for the first test", () => {
      expect(existsSync(instance.paths.dbFile)).toBe(true);
    });

    it("is still there for the next one, untouched by the cleanup after the first", () => {
      expect(existsSync(instance.paths.dbFile)).toBe(true);
      expect(instance.db.isOpen).toBe(true);
      expect(notes).toEqual([]);
    });
  });

  it("is closed when the group is over, newest first, and only then removed", () => {
    expect(notes).toEqual([
      "the group's own cleanup ran, folder still there",
      "server closed, folder still there",
      "database closed, folder still there",
    ]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("used in the wrong place", () => {
  const inAHook = { tempDir: "", track: "", sharedAcrossTests: "" };

  beforeAll(() => {
    inAHook.tempDir = refusal(() => tempDir());
    inAHook.track = refusal(() => track({ close() {} } as Instance));
    inAHook.sharedAcrossTests = refusal(() => sharedAcrossTests());
  });

  it("refuses a test's own folder or database when no test is running", () => {
    // Handed out in `beforeAll`, they would be cleaned up after the first test
    // while the rest still use them.
    expect(inAHook.tempDir).toMatch(/^tempDir\(\) was called outside a test/);
    expect(inAHook.track).toMatch(/^track\(\) was called outside a test/);
  });

  it("refuses to set up a group once the tests have started", () => {
    // That late, the cleanup could no longer be registered and would never run.
    expect(inAHook.sharedAcrossTests).toMatch(/was called from a test or a hook/);
    expect(refusal(() => sharedAcrossTests())).toMatch(/was called from a test or a hook/);
  });
});
