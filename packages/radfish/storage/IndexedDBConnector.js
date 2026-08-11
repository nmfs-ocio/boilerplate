import Dexie from "dexie";
import Connector from "./Connector.js";
import Engine from "./Engine.js";
import { byteSize } from "../utils/byteSize.js";

/**
 * IndexedDBEngine - A storage engine that uses IndexedDB (via Dexie) for persistence
 * @extends Engine
 */
class IndexedDBEngine extends Engine {
  /**
   * Create a new IndexedDBEngine
   * @param {string} dbName - The name of the database
   * @param {number} version - The database version
   */
  constructor(dbName, version = 1) {
    super();
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this.schemas = {};
    this._schemaQueue = Promise.resolve();
  }

  /**
   * Initialize the storage engine
   * @returns {Promise<boolean>} - Returns true when initialization is complete
   */
  async initialize() {
    try {
      // Create a new Dexie instance
      this.db = new Dexie(this.dbName);
      
      // Define tables using schemas
      const storeDefinitions = {};
      
      console.log({
        version: this.version,
        storeDefinitions
      })
      // Schemas will be added later via addSchema
      this.db.version(this.version).stores(storeDefinitions);
      
      // Open the database
      await this.db.open();
      return true;
    } catch (error) {
      console.error('Failed to initialize IndexedDB:', error);
      throw error;
    }
  }

  /**
   * Add a schema to the engine. Calls are serialized through an internal queue
   * to prevent race conditions when multiple schemas are added concurrently.
   * @param {string} tableName - The name of the table to create
   * @param {Object} schema - Schema definition with field information
   * @returns {Promise<void>} - Promise that resolves when schema is added
   */
  addSchema(tableName, schema) {
    const next = this._schemaQueue.then(() =>
      this._addSchemaInternal(tableName, schema)
    );
    // `.catch(() => {})` keeps the queue alive after a rejection so one failure
    // doesn't poison later calls; `next` still surfaces the real error.
    this._schemaQueue = next.catch(() => {});
    return next;
  }

  /**
   * Internal implementation of addSchema, executed sequentially via the queue.
   * @private
   */
  async _addSchemaInternal(tableName, schema) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    // Generate Dexie schema string (e.g. "++id,name,email")
    const schemaFields = [];

    // Get the primary key from the schema
    const primaryKeyField = schema._schema.primaryKey;

    // Process each field
    Object.entries(schema._schema.properties).forEach(([fieldName, fieldDef]) => {
      // Primary key with auto-increment
      if (fieldName === primaryKeyField && fieldDef.autoIncrement) {
        schemaFields.push(`++${fieldName}`);
      }
      // Regular primary key
      else if (fieldName === primaryKeyField) {
        schemaFields.push(`&${fieldName}`);
      }
      // Required fields should be indexed for better performance
      else if (schema._schema.required && schema._schema.required.includes(fieldName)) {
        schemaFields.push(fieldName);
      }
      // Explicitly indexed fields
      else if (fieldDef.indexed) {
        schemaFields.push(fieldName);
      }
      // Unique fields (non-primary)
      else if (fieldDef.unique) {
        schemaFields.push(`&${fieldName}`);
      }
    });

    // Make sure we have at least one field in the schema
    if (schemaFields.length === 0) {
      console.warn(`No indexed fields found for schema '${tableName}'. Adding primary key field.`);
      // If no primary key is defined, use the first field
      const firstField = Object.keys(schema._schema.properties)[0];
      schemaFields.push(`&${firstField}`);
    }

    // Store the schema definition
    this.schemas[tableName] = {
      dexieSchema: schemaFields.join(','),
      primaryKey: primaryKeyField,
      schema: schema  // Store the full schema reference
    };

    try {
      // Close current version
      this.db.close();

      // Create new version with updated schema
      const newDb = new Dexie(this.dbName);

      // Collect all current schemas
      const allSchemas = {};
      Object.entries(this.schemas).forEach(([table, { dexieSchema }]) => {
        allSchemas[table] = dexieSchema;
      });

      // Create new version
      newDb.version(this.version + 1).stores(allSchemas);

      // Open the new database and wait for it to complete
      await newDb.open();
      this.db = newDb;
      this.version++;

      console.log(`Schema added for '${tableName}' with fields: ${schemaFields.join(',')}`);
    } catch (error) {
      console.error(`Failed to update schema for '${tableName}':`, error);
      throw error;
    }
  }

  /**
   * Create a new record
   * @param {string} tableName - The name of the table/collection
   * @param {Object} data - The data to store
   * @returns {Promise<Object>} - The created data with any generated fields
   */
  async create(tableName, data) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    
    try {
      // Make sure the table is defined in the database
      if (!this.db.tables.some(table => table.name === tableName)) {
        throw new Error(`Table '${tableName}' is not defined in the database schema`);
      }
      
      // Generate an ID if not provided and not auto-increment
      let newData = { ...data };
      
      // Get schema info
      const schemaInfo = this.schemas[tableName];
      const primaryKey = schemaInfo?.primaryKey || null;
      
      // Auto-generate primary key if needed
      if (primaryKey && !newData[primaryKey]) {
        newData[primaryKey] = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      }
      
      // Add the record using table() to avoid direct property access issues
      const table = this.db.table(tableName);
      const id = await table.add(newData);
      
      // Return the complete record with the ID
      if (typeof id === 'number' || typeof id === 'string') {
        // If an ID was generated by Dexie (for auto-increment), get the full record
        return await table.get(id);
      }
      
      return newData;
    } catch (error) {
      console.error(`Failed to create record in ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Find records matching criteria
   * @param {string} tableName - The name of the table/collection
   * @param {Object} criteria - The search criteria (empty for all records)
   * @returns {Promise<Array>} - The matching records
   */
  async find(tableName, criteria = {}) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    
    try {
      // Make sure the table is defined in the database
      if (!this.db.tables.some(table => table.name === tableName)) {
        throw new Error(`Table '${tableName}' is not defined in the database schema`);
      }
      
      // Get the table using table() method
      const table = this.db.table(tableName);
      let collection = table.toCollection();
      
      // Apply filters if criteria provided
      if (Object.keys(criteria).length > 0) {
        collection = collection.filter(item => {
          return Object.entries(criteria).every(([key, value]) => {
            return item[key] === value;
          });
        });
      }
      
      // Return all matching records
      return await collection.toArray();
    } catch (error) {
      console.error(`Failed to find records in ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Update records matching the provided identifier
   * @param {string} tableName - The name of the table/collection
   * @param {Object} data - The data to update (must include id)
   * @returns {Promise<Object>} - The updated record
   */
  async update(tableName, data) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    
    try {
      // Make sure the table is defined in the database
      if (!this.db.tables.some(table => table.name === tableName)) {
        throw new Error(`Table '${tableName}' is not defined in the database schema`);
      }
      
      // Get schema info to find primary key
      const schemaInfo = this.schemas[tableName];
      const primaryKeyField = schemaInfo?.primaryKey || null;
      
      // Ensure primary key field exists in the schema
      if (!primaryKeyField) {
        throw new Error(`Cannot update record in ${tableName}: No primary key defined in schema. IndexedDB requires a primary key for updates.`);
      }
      
      // Require primary key for updates
      if (!data[primaryKeyField]) {
        throw new Error(`Update operation requires a '${primaryKeyField}' field (primary key)`);
      }
      
      // Get the table using table() method
      const table = this.db.table(tableName);
      
      // Get existing record
      const existingRecord = await table.get(data[primaryKeyField]);
      if (!existingRecord) {
        throw new Error(`Record with ${primaryKeyField}='${data[primaryKeyField]}' not found in table '${tableName}'`);
      }
      
      // Merge with new data
      const updatedRecord = { ...existingRecord, ...data };
      
      // Update the record
      await table.put(updatedRecord);
      
      // Return the updated record
      return updatedRecord;
    } catch (error) {
      console.error(`Failed to update record in ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Delete records from the collection
   * @param {string} tableName - The name of the table/collection
   * @param {Array<Object>} records - Array of records to delete
   * @returns {Promise<boolean>} - True if deletion was successful
   */
  async delete(tableName, records) {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    
    try {
      // Make sure the table is defined in the database
      if (!this.db.tables.some(table => table.name === tableName)) {
        throw new Error(`Table '${tableName}' is not defined in the database schema`);
      }
      
      // Get the table using table() method
      const table = this.db.table(tableName);
      
      // Get schema info to find primary key
      const schemaInfo = this.schemas[tableName];
      const primaryKeyField = schemaInfo?.primaryKey || null;
      // Ensure primary key field exists in the schema
      if (!primaryKeyField) {
        throw new Error(`Cannot delete records from ${tableName}: No primary key defined in schema. IndexedDB requires a primary key for deletion.`);
      }

      // Extract IDs from records
      const idsToDelete = records.map(record => record[primaryKeyField]).filter(Boolean);
      
      if (idsToDelete.length === 0) {
        console.warn(`No valid IDs found in records for deletion from ${tableName}`);
        return true;
      }
      
      // Delete each record by ID
      await table.bulkDelete(idsToDelete);
      return true;
    } catch (error) {
      console.error(`Failed to delete records from ${tableName}:`, error);
      throw error;
    }
  }
}

/**
 * IndexedDBConnector - A connector that uses IndexedDB for persistence
 * @extends Connector
 */
class IndexedDBConnector extends Connector {
  /**
   * Create a new IndexedDBConnector
   * @param {string} dbName - The name of the database
   * @param {number} version - The database version number
   */
  constructor(dbName, version = 1) {
    super(new IndexedDBEngine(dbName, version));
    this.dbName = dbName;
    this.version = version;
  }
  
  /**
   * Add a collection to the connector
   * @param {Schema} schema - The schema to add
   * @returns {Collection} - The created collection
   */
  async addCollection(schema) {
    // Add the schema to the engine (this now returns a Promise)
    await this.engine.addSchema(schema.name, schema);

    // Call the parent method to register the collection
    super.addCollection(schema);

    // Return the created collection
    return this.collections[schema.name];
  }

  /**
   * Total bytes currently stored in this connector's database, measured by
   * summing the serialized (UTF-8 JSON) size of every record across all tables.
   * RADFish measures this itself because the browser provides no per-database
   * byte breakdown cross-browser.
   *
   * Rows are streamed one at a time (cursor) rather than materialized via
   * toArray(), so peak memory stays flat regardless of table size. It is still
   * O(n) CPU, so it's an on-demand measurement — call it when you need a number,
   * not in a tight loop.
   *
   * Returns 0 for an uninitialized connector, and null when the database exists
   * but isn't currently open (e.g. mid schema-change) — null means "not
   * measurable right now", which callers must distinguish from "empty".
   * @returns {Promise<number|null>}
   */
  async usage() {
    const db = this.engine?.db;
    if (!db) return 0;
    if (typeof db.isOpen === "function" && !db.isOpen()) return null;

    let total = 0;
    for (const table of db.tables) {
      // Stream via cursor so a large table is never held in memory just to size it.
      await table.each((row) => { total += byteSize(row); });
    }
    return total;
  }
}

export default IndexedDBConnector;