import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.openSync;
fs.openSync = function (file, ...args) {
  if (String(file).endsWith('ledger.jsonl')) throw new Error('ledger unavailable');
  return original.call(this, file, ...args);
};
syncBuiltinESMExports();
