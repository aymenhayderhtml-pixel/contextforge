/**
 * validate.js — Validates a manifest object against manifest.schema.json.
 *
 * Returns clear, specific errors (not just pass/fail).
 * Uses Ajv (JSON Schema validator) for Draft 2020-12 support.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = join(__dirname, 'manifest.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, verbose: true });
addFormats(ajv);

const validateFn = ajv.compile(schema);

/**
 * Validate a manifest object against the schema.
 *
 * @param {object} manifest — the parsed manifest object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 *   - valid: true if the manifest conforms to the schema
 *   - errors: array of human-readable error strings (empty when valid)
 */
export function validateManifest(manifest) {
  const valid = validateFn(manifest);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = validateFn.errors.map((err) => {
    const path = err.instancePath || '(root)';
    const message = err.message || 'unknown error';

    // Include the failing value for enum violations to make diagnosis easy
    if (err.keyword === 'enum') {
      const allowed = err.params.allowedValues.join(', ');
      return `${path}: ${message}. Allowed values: [${allowed}]. Got: ${JSON.stringify(err.data)}`;
    }

    // For additionalProperties, name the offending key
    if (err.keyword === 'additionalProperties') {
      return `${path}: ${message}. Unexpected property: "${err.params.additionalProperty}"`;
    }

    // For required, name the missing property
    if (err.keyword === 'required') {
      return `${path}: ${message}. Missing property: "${err.params.missingProperty}"`;
    }

    // For type errors, show expected vs actual
    if (err.keyword === 'type') {
      return `${path}: ${message}. Got: ${JSON.stringify(err.data)}`;
    }

    return `${path}: ${message}`;
  });

  return { valid: false, errors };
}

/**
 * Convenience: validate and throw if invalid, for use in pipelines that
 * should abort on bad data.
 *
 * @param {object} manifest
 * @throws {Error} with all validation errors joined
 */
export function assertValid(manifest) {
  const result = validateManifest(manifest);
  if (!result.valid) {
    throw new Error(
      `Manifest validation failed:\n  - ${result.errors.join('\n  - ')}`
    );
  }
}
