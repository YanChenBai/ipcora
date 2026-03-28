import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { TStatic } from '../typebox';

export interface TSchema {
  '~kind': string;
}

export type TIpcSchema = TSchema | StandardSchemaV1;

export type TIpcSchemaType<T extends TIpcSchema> = T extends TSchema
  ? TStatic<T>
  : T extends StandardSchemaV1<infer _In, infer Out>
    ? Out
    : T;

export type Infer<T extends { static: any }> = T['static'];
