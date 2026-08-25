/**
 * Shared Zod primitives for event payload schemas.
 *
 * The recursive `jsonValue` schema accepts any JSON-safe value tree:
 * string | number | boolean | null | array/object of the same, recursively.
 * Functions, undefined, and bigint are rejected.
 */
import { z } from 'zod';

/** Recursive JSON-safe value — the fundamental payload building block. */
export const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/** Record<string, JsonValue> — metadata-style fields. */
export const jsonMetadata = z.record(z.string(), jsonValue);
