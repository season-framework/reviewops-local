'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requireOpsVersion,compareOpsVersions,OPS_CODEX_BASELINE}=require('../electron/ops-protocol.cjs');
test('validated Ops baseline uses SemVer prerelease ordering without a production semver dependency',()=>{
 for(const version of ['0.166.0-alpha.5.1','0.166.0-alpha.5.2','0.166.0-alpha.10','0.166.0-beta.1','0.166.0','0.166.1','1.0.0'])assert.equal(requireOpsVersion(version),version);
 for(const version of ['0.165.99','0.166.0-alpha','0.166.0-alpha.5','0.166.0-alpha.5.0','0.166.0-alpha.5.01','invalid','0.0166.0'])assert.throws(()=>requireOpsVersion(version),{code:'OPS_CODEX_PROTOCOL_UNSUPPORTED',deliveryState:'not_sent'});
 assert.equal(compareOpsVersions(OPS_CODEX_BASELINE,OPS_CODEX_BASELINE+'+build'),0);assert.equal(requireOpsVersion('codex-cli '+OPS_CODEX_BASELINE+'\n'),OPS_CODEX_BASELINE);
});
