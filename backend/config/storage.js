const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Where uploaded resource files live on disk instead of as base64 inside Mongo
// documents. In production this points at a Railway Volume mount (set via
// RESOURCE_STORAGE_DIR); locally it falls back to a gitignored folder so dev
// works with zero extra setup.
const STORAGE_DIR = process.env.RESOURCE_STORAGE_DIR || path.join(__dirname, '..', 'data', 'resources');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Writes a buffer under a random name and returns that name (what gets stored
// on the Resource document as file_path).
function saveFile(buffer) {
  const name = crypto.randomUUID();
  fs.writeFileSync(path.join(STORAGE_DIR, name), buffer);
  return name;
}

function readFile(name) {
  return fs.readFileSync(path.join(STORAGE_DIR, name));
}

function deleteFile(name) {
  if (!name) return;
  try { fs.unlinkSync(path.join(STORAGE_DIR, name)); } catch { /* already gone */ }
}

module.exports = { saveFile, readFile, deleteFile, STORAGE_DIR };
