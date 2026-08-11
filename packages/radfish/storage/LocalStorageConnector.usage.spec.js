// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import LocalStorageConnector from "./LocalStorageConnector.js";

/**
 * Tests for LocalStorageConnector.usage() — so localStorage-backed stores are
 * included in the Application's storage totals (previously they reported 0).
 */
describe("LocalStorageConnector.usage", () => {
  beforeEach(() => localStorage.clear());

  it("returns 0 when the namespace has no data", async () => {
    const connector = new LocalStorageConnector("empty-ns");
    expect(await connector.usage()).toBe(0);
  });

  it("counts the bytes of keys/values under its namespace", async () => {
    const connector = new LocalStorageConnector("auth-ns");
    await connector.engine.create("session", { id: "1", token: "abc" });
    const usage = await connector.usage();
    expect(usage).toBeGreaterThan(0);

    await connector.engine.create("session", { id: "2", token: "defghijklmnop" });
    expect(await connector.usage()).toBeGreaterThan(usage);
  });

  it("only counts its own namespace, not other keys", async () => {
    const mine = new LocalStorageConnector("mine");
    await mine.engine.create("t", { id: "1", v: "x" });
    const before = await mine.usage();

    // unrelated key from another namespace must not be counted
    localStorage.setItem("other:t", JSON.stringify([{ id: "9", v: "y".repeat(500) }]));
    expect(await mine.usage()).toBe(before);
  });
});
