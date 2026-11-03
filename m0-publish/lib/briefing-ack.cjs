'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeBriefingAckAtomic(ackDir, ack, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  if (!ackDir) {
    return;
  }
  fs.mkdirSync(ackDir, { recursive: true });
  const dest = path.join(ackDir, 'briefing-ack.json');
  const tmp = `${dest}.companion.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ack, null, 2)}\n`, 'utf8');
  renameSync(tmp, dest);
}

module.exports = {
  writeBriefingAckAtomic,
};
