/**
 * Shared byte-size helpers so every subsystem (logger sink, storage connectors)
 * measures storage the same way instead of re-implementing the primitive.
 */

const encoder = new TextEncoder();

/** Serialized UTF-8 byte size of a value's JSON form. */
export const byteSize = (value) => encoder.encode(JSON.stringify(value)).length;

/** UTF-8 byte size of an already-serialized string (no JSON re-encoding). */
export const byteSizeOfString = (str) => encoder.encode(str ?? "").length;
