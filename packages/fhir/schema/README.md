# The FHIR R4 JSON schema

`fhir.schema.json` is the official HL7 FHIR R4 JSON schema, unmodified.

- Source: https://hl7.org/fhir/R4/fhir.schema.json.zip (the file inside the zip), FHIR 4.0, `id` `http://hl7.org/fhir/json-schema/4.0`
- Fetched: 2026-11-01
- SHA-256: `2230406893b4cf002a4ee1e5e2bbeca22ac5d2d4931b3e9ef7b9594bbc376a01`

`src/validate.ts` compiles it with Ajv to check an exported Bundle. It is used by tests and by the end-to-end gate, never
by the running API: compiling 3.4 MB of schema on a request path is not worth it, and the builder in `src/bundle.ts` is
what the tests hold to the schema.

To check the file against the source: download the zip, unzip it, and compare the SHA-256 above.
