'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeTextAtomic(filePath, text, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.companion.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, value, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, writeFileSync, renameSync);
}

function removeFileIfExists(filePath, existsSync = fs.existsSync, unlinkSync = fs.unlinkSync) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

module.exports = {
  writeTextAtomic,
  writeJsonAtomic,
  removeFileIfExists,
};
