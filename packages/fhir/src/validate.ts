import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

const SCHEMA_PATH = new URL('../schema/fhir.schema.json', import.meta.url);
const draft06: object = createRequire(import.meta.url)('ajv/dist/refs/json-schema-draft-06.json');

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (compiled) return compiled;
  // The official schema is JSON Schema draft 06 and uses the FHIR `discriminator` keyword, which Ajv does not know.
  const ajv = new Ajv({ strict: false, allErrors: false });
  ajv.addMetaSchema(draft06);
  // The file names itself with the draft-04 keyword `id`; Ajv wants `$id`. Only that one key is renamed, in memory.
  const { id, ...schema } = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { id: string; [key: string]: unknown };
  compiled = ajv.compile({ ...schema, $id: id });
  return compiled;
}

export type FhirValidation = { valid: true } | { valid: false; errors: string[] };

/**
 * Checks a value against the official FHIR R4 JSON schema (the file in `schema/`). Test and gate use only: it reads
 * and compiles 3.4 MB of schema the first time, which the API's request path must not do.
 */
export function validateFhir(value: unknown): FhirValidation {
  const check = validator();
  if (check(value)) return { valid: true };
  // Ajv sets `errors` whenever it returns false.
  return { valid: false, errors: (check.errors as ErrorObject[]).map((error) => `${error.instancePath}: ${String(error.message)}`) };
}
