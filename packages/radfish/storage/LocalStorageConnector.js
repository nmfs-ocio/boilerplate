import Connector from "./Connector.js";
import Engine from "./Engine.js";
import { byteSizeOfString } from "../utils/byteSize.js";

/**
 * LocalStorageEngine - A storage engine that uses localStorage for persistence
 * @extends Engine
 */
class LocalStorageEngine extends Engine {
  /**
   * Create a new LocalStorageEngine
   * @param {string} namespace - The namespace to use for localStorage keys
   */
  constructor(namespace) {
    super();
    this.namespace = namespace;
  }

  /**
   * Initialize the storage engine
   * @returns {Promise<boolean>} - Returns true when initialization is complete
   */
  async initialize() {
    return true;
  }

  /**
   * Create a new record
   * @param {string} tableName - The name of the table/collection
   * @param {Object} data - The data to store
   * @returns {Promise<Object>} - The created data with any generated fields
   */
  async create(tableName, data) {
    const uuid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
    const storageKey = `${this.namespace}:${tableName}`;
    
    // Get existing data for this table or initialize empty array
    const existingData = localStorage.getItem(storageKey);
    const records = existingData ? JSON.parse(existingData) : [];
    
    // Create the new record with UUID
    const newRecord = { ...data, id: data.id || uuid };
    
    // Add to records and save
    records.push(newRecord);
    localStorage.setItem(storageKey, JSON.stringify(records));
    
    return newRecord;
  }

  /**
   * Find records matching criteria
   * @param {string} tableName - The name of the table/collection
   * @param {Object} criteria - The search criteria (empty for all records)
   * @returns {Promise<Array>} - The matching records
   */
  async find(tableName, criteria = {}) {
    const storageKey = `${this.namespace}:${tableName}`;
    
    // Get existing data for this table or return empty array
    const existingData = localStorage.getItem(storageKey);
    if (!existingData) return [];
    
    const records = JSON.parse(existingData);
    
    // If no criteria, return all records
    if (Object.keys(criteria).length === 0) {
      return records;
    }
    
    // Filter records by criteria
    return records.filter(record => {
      return Object.entries(criteria).every(([key, value]) => {
        return record[key] === value;
      });
    });
  }

  /**
   * Update records matching the provided identifier
   * @param {string} tableName - The name of the table/collection
   * @param {Object} data - The data to update (must include id)
   * @returns {Promise<Object>} - The updated record
   */
  async update(tableName, data) {
    if (!data.id) {
      throw new Error("Update operation requires an 'id' field");
    }
    
    const storageKey = `${this.namespace}:${tableName}`;
    
    // Get existing data
    const existingData = localStorage.getItem(storageKey);
    if (!existingData) {
      throw new Error(`No records found for table: ${tableName}`);
    }
    
    const records = JSON.parse(existingData);
    
    // Find and update the record
    const recordIndex = records.findIndex(record => record.id === data.id);
    if (recordIndex === -1) {
      throw new Error(`Record with id '${data.id}' not found in table '${tableName}'`);
    }
    
    // Update the record with new data
    const updatedRecord = { ...records[recordIndex], ...data };
    records[recordIndex] = updatedRecord;
    
    // Save the updated records
    localStorage.setItem(storageKey, JSON.stringify(records));
    
    return updatedRecord;
  }

  /**
   * Delete records from the collection
   * @param {string} tableName - The name of the table/collection
   * @param {Array<Object>} records - Array of records to delete
   * @returns {Promise<boolean>} - True if deletion was successful
   */
  async delete(tableName, records) {
    const storageKey = `${this.namespace}:${tableName}`;
    
    // Get existing data
    const existingData = localStorage.getItem(storageKey);
    if (!existingData) {
      return true; // Nothing to delete
    }
    
    const allRecords = JSON.parse(existingData);
    
    // Extract IDs from the records to delete
    const idsToDelete = records.map(record => record.id).filter(Boolean);
    
    if (idsToDelete.length === 0) {
      return true; // No valid IDs to delete
    }
    
    // Filter out the records to delete
    const remainingRecords = allRecords.filter(record => !idsToDelete.includes(record.id));
    
    // Save the filtered records
    localStorage.setItem(storageKey, JSON.stringify(remainingRecords));
    
    return true;
  }
}

/**
 * LocalStorageConnector - A connector that uses localStorage for persistence
 * @extends Connector
 */
class LocalStorageConnector extends Connector {
  /**
   * Create a new LocalStorageConnector
   * @param {string} namespace - The namespace to use for localStorage keys
   */
  constructor(namespace) {
    super(new LocalStorageEngine(namespace));
    this.namespace = namespace;
  }

  /**
   * Total bytes this connector occupies in localStorage — the UTF-8 size of
   * every key/value pair under this connector's `namespace:` prefix. Lets the
   * Application include localStorage-backed stores in its storage totals (the
   * browser gives no per-store breakdown).
   * @returns {Promise<number>}
   */
  async usage() {
    if (typeof localStorage === "undefined") return 0;
    const prefix = `${this.namespace}:`;
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        total += byteSizeOfString(key) + byteSizeOfString(localStorage.getItem(key));
      }
    }
    return total;
  }
}

export default LocalStorageConnector;