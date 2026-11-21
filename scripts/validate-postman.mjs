import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import draft4 from 'ajv/lib/refs/json-schema-draft-04.json' with { type: 'json' };

const collectionPath = resolve(
  process.argv[2] ?? 'postman/hotel-offer-orchestrator.postman_collection.json',
);
const schema = JSON.parse(
  await readFile(new URL('../postman/schema/collection-v2.1.0.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ schemaId: 'id', meta: false, allErrors: true });
ajv.addMetaSchema(draft4);
const validate = ajv.compile(schema);

try {
  const collection = JSON.parse(await readFile(collectionPath, 'utf8'));
  if (!validate(collection)) {
    console.error(ajv.errorsText(validate.errors, { separator: '\n' }));
    process.exitCode = 1;
  } else {
    console.log(`Valid Postman v2.1 collection (offline Draft 4): ${collectionPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to read collection');
  process.exitCode = 1;
}
