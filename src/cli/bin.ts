#!/usr/bin/env node
import { runCli } from './main.js';

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  },
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
process.exitCode = code;
