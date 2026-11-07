'use strict';
// Windows uses built-in DPAPI. macOS needs the app-owned N-API Keychain addon.
if(process.platform==='darwin')require('./build-remote-identity.cjs');
