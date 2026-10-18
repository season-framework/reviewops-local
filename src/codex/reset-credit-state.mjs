// Keep eligibility independent of translated display labels.
export const validCreditTime=value=>Number.isSafeInteger(value)&&value>=0;
export function resetCreditStatus(credit,currentTime=Date.now()/1000) {
 if(!credit||typeof credit.id!=='string'||!credit.id.trim())return 'unknown';
 if(credit.resetType!=='codexRateLimits')return credit.resetType?'unsupported':'unknown';
 if(['used','redeemed'].includes(credit.status))return 'used';
 if(credit.status==='redeeming')return 'processing';
 if(credit.status==='expired')return 'expired';
 if(credit.status!=='available')return 'unknown';
 if(!validCreditTime(credit.grantedAt)||(credit.expiresAt!=null&&!validCreditTime(credit.expiresAt)))return 'unknown';
 if(credit.expiresAt!=null&&credit.expiresAt<credit.grantedAt)return 'unknown';
 if(credit.expiresAt!=null&&credit.expiresAt<=currentTime)return 'expired';
 if(credit.grantedAt>currentTime)return 'pending';
 return 'available';
}
export const isResetCreditSelectable=(credit,currentTime)=>resetCreditStatus(credit,currentTime)==='available';
