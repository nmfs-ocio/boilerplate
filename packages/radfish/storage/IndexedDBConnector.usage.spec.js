// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import IndexedDBConnector from "./IndexedDBConnector.js";
import Schema from "./Schema.js";

/**
 * Tests for IndexedDBConnector.usage() — the byte measurement RADFish does
 * itself for a data Store (the browser gives no per-database breakdown).
 * Runs against a real (fake-indexeddb) database. Unique dbName per test.
 */
let counter = 0;
const uniqueDbName = () => `usage-${Date.now()}-${++counter}`;

const reportsSchema = () =>
  new Schema({
    name: "reports",
    fields: {
      id: { type: "string", primaryKey: true },
      species: { type: "string" },
    },
  });

describe("IndexedDBConnector.usage", () => {
  it("returns 0 for an empty database", async () => {
    const connector = new IndexedDBConnector(uniqueDbName());
    await connector.initialize();
    await connector.addCollection(reportsSchema());
    expect(await connector.usage()).toBe(0);
  });

  it("sums the serialized bytes of all stored records", async () => {
    const connector = new IndexedDBConnector(uniqueDbName());
    await connector.initialize();
    const reports = await connector.addCollection(reportsSchema());

    await reports.create({ id: "1", species: "Atlantic cod" });
    await reports.create({ id: "2", species: "haddock" });
    const usage = await connector.usage();
    expect(usage).toBeGreaterThan(0);

    // adding another record increases the measured usage
    await reports.create({ id: "3", species: "salmon" });
    expect(await connector.usage()).toBeGreaterThan(usage);
  });

  it("returns 0 when the database isn't initialized", async () => {
    const connector = new IndexedDBConnector(uniqueDbName());
    expect(await connector.usage()).toBe(0);
  });
});
