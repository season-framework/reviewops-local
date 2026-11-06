'use strict';

const {CronExpressionParser} = require('cron-parser');
const MAX_DELAY = 2 ** 31 - 1;

function scheduleError(message) { return Object.assign(new Error(message), {code:'INVALID_OPS_SCHEDULE'}); }
function validateSchedule(cron, timezone) {
  if(typeof cron!=='string'||cron.length>256||cron.trim().split(/\s+/).length!==5||/[\r\n\0]/.test(cron)||/\bH\b/i.test(cron))
    throw scheduleError('예약은 분·시·일·월·요일의 cron 5개 항목으로 입력하십시오.');
  if(typeof timezone!=='string'||!timezone||timezone.length>128)throw scheduleError('IANA 시간대를 입력하십시오.');
  try { new Intl.DateTimeFormat('en',{timeZone:timezone}).format(); }
  catch { throw scheduleError('사용할 수 있는 IANA 시간대를 입력하십시오.'); }
  try { CronExpressionParser.parse(cron.trim(),{tz:timezone,currentDate:new Date()}).next(); }
  catch { throw scheduleError('실행 가능한 cron 반복 일정을 입력하십시오.'); }
  return {cron:cron.trim().replace(/\s+/g,' '),timezone};
}
function nextOccurrence(cron,timezone,after=Date.now()) {
  const valid=validateSchedule(cron,timezone);
  return CronExpressionParser.parse(valid.cron,{tz:valid.timezone,currentDate:new Date(after)}).next().toISOString();
}

// Each wake performs one bounded due scan. The manager atomically advances every
// consumed schedule past now, so sleep and restart never replay a catch-up loop.
class OpsScheduler {
  constructor({tick,nextDue,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}) {
    Object.assign(this,{tick,nextDue,now,setTimer,clearTimer,onError});
    this.timer=null;this.running=null;this.closed=false;
  }
  arm() {
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;if(this.closed||this.running)return;
    const next=this.nextDue(),remaining=next===null?60_000:new Date(next).getTime()-this.now();
    const delay=remaining<=0?60_000:Math.max(1000,Math.min(60_000,remaining));
    this.timer=this.setTimer(()=>{this.timer=null;void this.wake();},Math.min(MAX_DELAY,delay));
    this.timer?.unref?.();
  }
  wake() {
    if(this.closed)return Promise.resolve();if(this.running)return this.running;
    const pending=Promise.resolve().then(()=>this.tick(this.now())).catch(error=>this.onError(error))
      .finally(()=>{if(this.running===pending)this.running=null;this.arm();});
    this.running=pending;return pending;
  }
  close(){this.closed=true;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
}
module.exports={validateSchedule,nextOccurrence,OpsScheduler};
