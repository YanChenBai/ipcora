import type { StandardSchemaV1 } from '@standard-schema/spec';

import { Compile } from '../typebox';
import type { TIpcSchema } from '../types';

export async function standardValidate<T extends StandardSchemaV1>(
  schema: T,
  input: StandardSchemaV1.InferInput<T>,
): Promise<StandardSchemaV1.InferOutput<T>> {
  let result = schema['~standard'].validate(input);
  if (result instanceof Promise) result = await result;

  // if the `issues` field exists, the validation failed
  if (result.issues) {
    throw new Error(JSON.stringify(result.issues, null, 2));
  }

  return result.value;
}

export async function parser<const T extends TIpcSchema>(schema: T, data: any) {
  if ('~standard' in schema) {
    return await standardValidate(schema, data);
  } else {
    const errors = Compile(schema).Errors(data);

    if (errors.length) {
      throw new Error(JSON.stringify(errors, null, 2));
    }

    return Compile(schema).Parse(data);
  }
}
