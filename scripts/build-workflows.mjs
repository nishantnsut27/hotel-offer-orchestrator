import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

const bundle = await bundleWorkflowCode({
  workflowsPath: resolve('dist/workflows/index.js'),
});
await mkdir('dist', { recursive: true });
await writeFile('dist/workflow-bundle.js', bundle.code);
