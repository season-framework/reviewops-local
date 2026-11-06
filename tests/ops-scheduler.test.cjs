'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OpsScheduler}=require('../electron/ops-scheduler.cjs');

test('unrelated state updates cannot postpone an armed ownership probe, while a newly earlier schedule advances it',async()=>{
 let now=Date.parse('2026-11-07T00:00:00Z'),next=null,id=0,ticks=0;const timers=new Map(),cleared=[];
 const scheduler=new OpsScheduler({now:()=>now,nextDue:()=>next,tick:async()=>{ticks++;},setTimer:(callback,delay)=>{const value=++id;timers.set(value,{callback,at:now+delay});return value;},clearTimer:value=>{cleared.push(value);timers.delete(value);}});
 scheduler.arm();const original=scheduler.timer,firstAt=timers.get(original).at;
 for(let n=0;n<5;n++){now+=10000;scheduler.arm();assert.equal(scheduler.timer,original);assert.equal(timers.get(original).at,firstAt);}
 next=new Date(now+2000).toISOString();scheduler.arm();assert.deepEqual(cleared,[original]);assert.equal(timers.get(scheduler.timer).at,now+2000);
 now+=2000;const due=timers.get(scheduler.timer);timers.delete(scheduler.timer);due.callback();await scheduler.running;assert.equal(ticks,1);assert.ok(timers.has(scheduler.timer));scheduler.close();assert.equal(timers.size,0);
});
