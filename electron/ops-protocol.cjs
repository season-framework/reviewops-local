'use strict';
// This is the validated ReviewOps protocol baseline, not a claim about the
// earliest upstream version that introduced each experimental method.
const OPS_CODEX_BASELINE='0.166.0-alpha.5.1';
function parts(value){
  if(typeof value!=='string'||value.length>128)return null;
  const match=/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if(!match||match[4]?.split('.').some(item=>/^\d+$/.test(item)&&item.length>1&&item[0]==='0'))return null;
  return {main:match.slice(1,4).map(Number),pre:match[4]?.split('.')||null};
}
function compare(left,right){
  const a=parts(left),b=parts(right);if(!a||!b)return null;
  for(let index=0;index<3;index++)if(a.main[index]!==b.main[index])return a.main[index]>b.main[index]?1:-1;
  if(!a.pre||!b.pre)return a.pre===b.pre?0:a.pre?-1:1;
  for(let index=0;index<Math.max(a.pre.length,b.pre.length);index++){
    const x=a.pre[index],y=b.pre[index];if(x===y)continue;if(x===undefined||y===undefined)return x===undefined?-1:1;
    const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn!==yn)return xn?-1:1;
    if(xn)return BigInt(x)>BigInt(y)?1:-1;return x>y?1:-1;
  }
  return 0;
}
function unsupported(){return Object.assign(new Error(`Ops requires Codex CLI ${OPS_CODEX_BASELINE} or later and its supported goal tools. Update the selected Codex CLI before starting this goal.`),{code:'OPS_CODEX_PROTOCOL_UNSUPPORTED',deliveryState:'not_sent'});}
function requireOpsVersion(value){const version=typeof value==='string'?value.trim().replace(/^codex-cli\s+/,''):'';if(compare(version,OPS_CODEX_BASELINE)===null||compare(version,OPS_CODEX_BASELINE)<0)throw unsupported();return version;}
module.exports={OPS_CODEX_BASELINE,requireOpsVersion,compareOpsVersions:compare,opsProtocolUnsupported:unsupported};
