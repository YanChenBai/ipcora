import type { EventSchemaInput } from './types';

export type {
  EventDefinition,
  EventDefinitions,
  EventEmitOptions,
  EventEmitter,
  EventNames,
  EventPayload,
  EventPayloadByName,
  EventSchema,
  EventSchemaInput,
  ExtractEvents,
  ExtractHandlers,
} from './types';

/**
 * A lightweight identity function that preserves the literal keys and
 * schema types of an event map so the router can derive properly typed
 * {@link EventDefinition} and {@link EventEmitter} members.
 *
 * @example
 * ```ts
 * import { defineEventSchema, z } from 'ipcora/event'
 *
 * const events = defineEventSchema({
 *   userLogin: z.object({ userId: z.string() }),
 * })
 * // events.userLogin is still the same schema object,
 * // but `events` now carries the exact literal type information.
 * ```
 */
export function defineEventSchema<const TEvents extends Record<string, unknown>>(
  schema: TEvents & EventSchemaInput<TEvents>,
): TEvents & EventSchemaInput<TEvents> {
  return schema;
}
