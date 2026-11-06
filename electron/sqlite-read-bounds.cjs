'use strict';

// Storage bytes are not JSON UTF-8 bytes. This is read metadata, not a grant.
function encodingByteFactors(encoding) {
  if (encoding === 'UTF-8') return Object.freeze({encoding, general: 3, ascii: 1});
  if (encoding === 'UTF-16le' || encoding === 'UTF-16be')
    return Object.freeze({encoding, general: 2, ascii: 2});
  return null;
}

module.exports = {encodingByteFactors};
