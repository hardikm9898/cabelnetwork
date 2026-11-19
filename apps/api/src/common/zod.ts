import { ArgumentMetadata, Body, Injectable, PipeTransform, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { AppError } from './errors';

@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Request validation failed',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      );
    }
    return result.data;
  }
}

function toOpenApi(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: 'object' };
  }
}

/** Validates the request body with a zod schema and documents it in OpenAPI. */
export function ZodBody(schema: z.ZodType): ParameterDecorator {
  return (target, propertyKey, index) => {
    Body(new ZodValidationPipe(schema))(target, propertyKey, index);
    if (propertyKey !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
      if (descriptor) ApiBody({ schema: toOpenApi(schema) })(target, propertyKey, descriptor);
    }
  };
}

/** Validates (and coerces) the query string with a zod schema. */
export function ZodQuery(schema: z.ZodType): ParameterDecorator {
  return Query(new ZodValidationPipe(schema));
}
