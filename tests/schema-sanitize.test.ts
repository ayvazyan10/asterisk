// Unit tests for the grammar-hostile-keyword sanitiser. See
// src/providers/schema-sanitize.ts for why this exists: llama.cpp's GBNF
// grammar compiler rejects a `pattern` nested under an object property, and
// separately rejects a large `minLength`/`maxLength`/`minItems`/`maxItems`
// bound, each with its own distinct HTTP 400 from the server. All five
// keywords are validation-only for tool-call decoding regardless.

import { describe, expect, it } from 'vitest';

import { stripGrammarHostileKeywords } from '../src/providers/schema-sanitize.ts';

describe('stripGrammarHostileKeywords', () => {
  it('removes pattern at the top level', () => {
    expect(stripGrammarHostileKeywords({ type: 'string', pattern: '^\\d+$' })).toEqual({
      type: 'string',
    });
  });

  it('removes pattern nested two levels deep', () => {
    const schema = {
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            x: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            x: { type: 'string' },
          },
        },
      },
    });
  });

  it.each([
    ['minLength', 1],
    ['maxLength', 2000],
    ['minItems', 1],
    ['maxItems', 50],
  ])('removes %s nested two levels deep', (keyword, bound) => {
    const schema = {
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            x: { type: keyword.endsWith('Items') ? 'array' : 'string', [keyword]: bound },
          },
        },
      },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            x: { type: keyword.endsWith('Items') ? 'array' : 'string' },
          },
        },
      },
    });
  });

  it('does not remove enum, const, format, minimum, maximum or multipleOf', () => {
    const schema = {
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['a', 'b'], const: 'a' },
            when: { type: 'string', format: 'date' },
            n: { type: 'number', minimum: 0, maximum: 10, multipleOf: 2 },
          },
        },
      },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual(schema);
  });

  it('removes pattern inside items (single schema and tuple form)', () => {
    const singleSchema = {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z]+$' },
    };
    expect(stripGrammarHostileKeywords(singleSchema)).toEqual({
      type: 'array',
      items: { type: 'string' },
    });

    const tupleSchema = {
      type: 'array',
      items: [{ type: 'string', pattern: '^a$' }, { type: 'number' }],
    };
    expect(stripGrammarHostileKeywords(tupleSchema)).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('removes pattern inside prefixItems', () => {
    const schema = {
      type: 'array',
      prefixItems: [{ type: 'string', pattern: '^a$' }, { type: 'number' }],
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('removes pattern inside anyOf and allOf', () => {
    const schema = {
      anyOf: [
        { type: 'string', pattern: '^a$' },
        { type: 'object', properties: { y: { type: 'string', pattern: '^b$' } } },
      ],
      allOf: [{ type: 'string', pattern: '^c$' }],
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'object', properties: { y: { type: 'string' } } }],
      allOf: [{ type: 'string' }],
    });
  });

  it('removes pattern inside oneOf and not', () => {
    const schema = {
      oneOf: [{ type: 'string', pattern: '^a$' }],
      not: { type: 'string', pattern: '^b$' },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      oneOf: [{ type: 'string' }],
      not: { type: 'string' },
    });
  });

  it('removes pattern inside $defs and definitions', () => {
    const schema = {
      $defs: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      definitions: { name: { type: 'string', pattern: '^[A-Z]' } },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      $defs: { date: { type: 'string' } },
      definitions: { name: { type: 'string' } },
    });
  });

  it('removes pattern inside additionalProperties when it is a schema, keeps it when boolean', () => {
    const schemaObject = { additionalProperties: { type: 'string', pattern: '^a$' } };
    expect(stripGrammarHostileKeywords(schemaObject)).toEqual({
      additionalProperties: { type: 'string' },
    });

    const schemaBool = { additionalProperties: false };
    expect(stripGrammarHostileKeywords(schemaBool)).toEqual({ additionalProperties: false });
  });

  it('does not mutate the input object', () => {
    const original = {
      type: 'object',
      properties: {
        wrap: {
          type: 'object',
          properties: {
            x: { type: 'string', pattern: '^\\d+$', maxLength: 2000 },
            items: { type: 'array', minItems: 1, maxItems: 50 },
          },
        },
      },
      anyOf: [{ type: 'string', pattern: '^a$' }],
    };
    const pristine = JSON.parse(JSON.stringify(original));

    stripGrammarHostileKeywords(original);

    expect(original).toEqual(pristine);
  });

  it('keeps a property legitimately named "pattern", including its own nested keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern.', pattern: '^.+$' },
      },
      required: ['pattern'],
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern.' },
      },
      required: ['pattern'],
    });
  });

  it('keeps a property legitimately named "maxLength", including its own nested keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        maxLength: { type: 'number', description: 'Max length.', maximum: 2000, maxLength: 4 },
      },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      properties: {
        maxLength: { type: 'number', description: 'Max length.', maximum: 2000 },
      },
    });
  });

  it('keeps patternProperties keys while sanitising their subschemas', () => {
    const schema = {
      type: 'object',
      patternProperties: {
        '^\\d+$': { type: 'string', pattern: '^[a-z]+$', maxLength: 10 },
      },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      patternProperties: {
        '^\\d+$': { type: 'string' },
      },
    });
  });

  it.each([null, undefined, 'str', 42, true, false, []])(
    'handles non-object input %p without throwing',
    (input) => {
      expect(() => stripGrammarHostileKeywords(input)).not.toThrow();
      expect(stripGrammarHostileKeywords(input)).toEqual(input);
    },
  );

  it('sanitises each element of an array input', () => {
    expect(
      stripGrammarHostileKeywords([{ type: 'string', pattern: '^a$' }, { type: 'number' }]),
    ).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  // The conditional keywords hold schemas too, and a `pattern` hidden in one
  // of them reaches the endpoint exactly like any other. Built through
  // JSON.parse because a literal with a `then` key is a thenable, which
  // Biome refuses on sight and for good reason.
  it('removes pattern inside if / then / else and contains', () => {
    const schema = JSON.parse(
      `{"type":"object",
        "if":{"properties":{"kind":{"const":"date"}}},
        "then":{"properties":{"value":{"type":"string","pattern":"^\\\\d{4}$"}}},
        "else":{"properties":{"value":{"type":"string","pattern":"^[a-z]+$"}}},
        "contains":{"type":"string","pattern":"^x$"}}`,
    );
    expect(stripGrammarHostileKeywords(schema)).toEqual(
      JSON.parse(
        `{"type":"object",
          "if":{"properties":{"kind":{"const":"date"}}},
          "then":{"properties":{"value":{"type":"string"}}},
          "else":{"properties":{"value":{"type":"string"}}},
          "contains":{"type":"string"}}`,
      ),
    );
  });

  it('removes pattern inside dependentSchemas and propertyNames', () => {
    const schema = {
      type: 'object',
      dependentSchemas: {
        pattern: { properties: { flags: { type: 'string', pattern: '^[gimsu]*$' } } },
      },
      propertyNames: { type: 'string', pattern: '^[a-z]+$' },
    };
    expect(stripGrammarHostileKeywords(schema)).toEqual({
      type: 'object',
      dependentSchemas: { pattern: { properties: { flags: { type: 'string' } } } },
      propertyNames: { type: 'string' },
    });
  });
});
