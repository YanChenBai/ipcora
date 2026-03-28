import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

export const t = Type;

export { Compile, Type };

export type { TSchema, Static as TStatic };
