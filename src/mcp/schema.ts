/**
 * Tool descriptions and input schemas from MCP servers are untrusted text
 * the model reads in every request. Descriptions are stripped of control
 * and format characters and neutralised; schemas are reduced to a small
 * safe subset (or the tool is dropped), and arguments are validated against
 * that subset before anything is sent.
 */

import { neutralizeRuntimeText } from "../agent/injection-defense.js";

export const MAX_SCHEMA_BYTES = 6 * 1024;
export const MAX_SCHEMA_DEPTH = 8;
const MAX_PROPERTIES = 64;
const MAX_BRANCHES = 8;
const MAX_ENUM = 64;
const NESTED_TEXT_CHARS = 200;
const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Untrusted one-line text: no control/format characters, tags neutralised, capped. */
export function sanitizeText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const stripped = text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\p{Cf}\u2028\u2029]/gu, "");
  const out = neutralizeRuntimeText(stripped).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}\u2026` : out;
}

export type JsonSchema = Record<string, unknown>;

class SchemaRefused extends Error {}

function cleanLiteral(v: unknown): unknown {
  if (typeof v === "string") return sanitizeText(v, NESTED_TEXT_CHARS);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  // Objects and arrays as enum/const/default values carry text the model
  // reads but nothing a call needs.
  throw new SchemaRefused("non-scalar enum, const or default value");
}

function normalizeNode(node: unknown, depth: number): JsonSchema {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaRefused(`schema deeper than ${MAX_SCHEMA_DEPTH}`);
  if (node === true || node === undefined) return {};
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new SchemaRefused("schema node is not an object");
  const src = node as Record<string, unknown>;
  if ("$ref" in src || "$defs" in src || "definitions" in src) throw new SchemaRefused("$ref is not supported");
  const out: JsonSchema = {};
  if (src.type !== undefined) {
    const types = Array.isArray(src.type) ? src.type : [src.type];
    if (types.length === 0 || types.some((t) => typeof t !== "string" || !TYPES.has(t))) {
      throw new SchemaRefused("unknown type");
    }
    out.type = Array.isArray(src.type) ? [...types] : src.type;
  }
  if (typeof src.description === "string") {
    const d = sanitizeText(src.description, NESTED_TEXT_CHARS);
    if (d) out.description = d;
  }
  if (src.properties !== undefined) {
    if (!src.properties || typeof src.properties !== "object" || Array.isArray(src.properties)) {
      throw new SchemaRefused("properties is not an object");
    }
    const entries = Object.entries(src.properties as Record<string, unknown>);
    if (entries.length > MAX_PROPERTIES) throw new SchemaRefused(`more than ${MAX_PROPERTIES} properties`);
    const props: Record<string, JsonSchema> = {};
    for (const [name, sub] of entries) {
      if (!PROPERTY_NAME_RE.test(name)) throw new SchemaRefused("property name outside [A-Za-z0-9_.-]{1,64}");
      props[name] = normalizeNode(sub, depth + 1);
    }
    out.properties = props;
  }
  if (src.required !== undefined) {
    if (!Array.isArray(src.required) || src.required.some((r) => typeof r !== "string" || !PROPERTY_NAME_RE.test(r))) {
      throw new SchemaRefused("required is not a list of property names");
    }
    if (src.required.length > 0) out.required = [...new Set(src.required as string[])];
  }
  if (src.items !== undefined) {
    if (Array.isArray(src.items)) throw new SchemaRefused("tuple items are not supported");
    out.items = normalizeNode(src.items, depth + 1);
  }
  if (src.enum !== undefined) {
    if (!Array.isArray(src.enum) || src.enum.length === 0 || src.enum.length > MAX_ENUM) {
      throw new SchemaRefused("enum is not a short list");
    }
    out.enum = src.enum.map(cleanLiteral);
  }
  if (src.const !== undefined) out.const = cleanLiteral(src.const);
  if (src.default !== undefined) {
    try {
      out.default = cleanLiteral(src.default);
    } catch {
      // A complex default is only a hint; drop it.
    }
  }
  for (const k of ["minimum", "maximum"] as const) {
    if (src[k] !== undefined) {
      if (typeof src[k] !== "number" || !Number.isFinite(src[k])) throw new SchemaRefused(`${k} is not a number`);
      out[k] = src[k];
    }
  }
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (src[k] !== undefined) {
      if (typeof src[k] !== "number" || !Number.isInteger(src[k]) || (src[k] as number) < 0) {
        throw new SchemaRefused(`${k} is not a non-negative integer`);
      }
      out[k] = src[k];
    }
  }
  if (src.additionalProperties !== undefined) {
    // Schema-valued additionalProperties is reduced to "allowed".
    out.additionalProperties = src.additionalProperties !== false;
  }
  for (const k of ["anyOf", "oneOf"] as const) {
    if (src[k] !== undefined) {
      if (!Array.isArray(src[k]) || (src[k] as unknown[]).length === 0 || (src[k] as unknown[]).length > MAX_BRANCHES) {
        throw new SchemaRefused(`${k} needs 1 to ${MAX_BRANCHES} branches`);
      }
      out[k] = (src[k] as unknown[]).map((b) => normalizeNode(b, depth + 1));
    }
  }
  return out;
}

/** The safe subset of an input schema, or why the tool is dropped. */
export function normalizeInputSchema(schema: unknown): { schema: JsonSchema } | { error: string } {
  try {
    const root = normalizeNode(schema ?? { type: "object" }, 0);
    if (root.type === undefined) root.type = "object";
    if (root.type !== "object") return { error: "input schema root is not an object" };
    if (!root.properties) root.properties = {};
    const size = Buffer.byteLength(JSON.stringify(root));
    if (size > MAX_SCHEMA_BYTES) return { error: `input schema is ${size} bytes (over ${MAX_SCHEMA_BYTES})` };
    return { schema: root };
  } catch (err) {
    return { error: err instanceof SchemaRefused ? err.message : "input schema could not be read" };
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  if (want === "number") return got === "number" || got === "integer";
  return want === got;
}

function check(schema: JsonSchema, v: unknown, at: string, depth: number): string | null {
  if (depth > MAX_SCHEMA_DEPTH + 2) return `${at} is nested too deeply`;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(t, v))) return `${at} must be ${types.join(" or ")}`;
  }
  if (schema.enum && !(schema.enum as unknown[]).some((e) => e === v)) return `${at} must be one of the listed values`;
  if (schema.const !== undefined && schema.const !== v) return `${at} must be ${JSON.stringify(schema.const)}`;
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (typeof schema.maximum === "number" && v > schema.maximum) return `${at} must be <= ${schema.maximum}`;
  }
  if (typeof v === "string") {
    if (typeof schema.minLength === "number" && [...v].length < schema.minLength) return `${at} is too short`;
    if (typeof schema.maxLength === "number" && [...v].length > schema.maxLength) return `${at} is too long`;
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === "number" && v.length < schema.minItems) return `${at} has too few items`;
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems) return `${at} has too many items`;
    if (schema.items) {
      for (let i = 0; i < v.length; i++) {
        const e = check(schema.items as JsonSchema, v[i], `${at}[${i}]`, depth + 1);
        if (e) return e;
      }
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    // Own properties only: names like "constructor" or "toString" must not
    // match Object.prototype.
    for (const r of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(obj, r)) return `${at}.${r} is required`;
    }
    for (const [k, val] of Object.entries(obj)) {
      if (Object.hasOwn(props, k)) {
        const e = check(props[k], val, `${at}.${k}`, depth + 1);
        if (e) return e;
      } else if (schema.additionalProperties === false) {
        return `${at}.${k} is not an accepted argument`;
      }
    }
  }
  for (const k of ["anyOf", "oneOf"] as const) {
    const branches = schema[k] as JsonSchema[] | undefined;
    if (branches && !branches.some((b) => check(b, v, at, depth + 1) === null)) {
      return `${at} matches none of the accepted forms`;
    }
  }
  return null;
}

/** Why args do not fit the normalised schema, or null. */
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  return check(schema, args, "args", 0);
}
