#include "../../experiments/macos-virtual-display/topology-trace.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>

typedef struct { ROTrace *trace; unsigned int id; } Worker;
static void *record_worker(void *input) {
  Worker *worker=input;
  for(unsigned int n=0;n<4;n++) {
    ROTraceTicket ticket=ro_trace_begin(worker->trace);
    if(ticket.valid)ro_trace_publish(worker->trace,ticket,
      ((uint64_t)worker->id<<32)|n,worker->id,n);
  }
  return NULL;
}
int main(void) {
  // A callback paused before publication survives stop/removal without a read
  // of its uninitialized plain payload. Reentrant callbacks have distinct slots.
  ROTrace paused;ro_trace_init(&paused);assert(ro_trace_lock_free(&paused));
  atomic_store(&paused.phase,3);ROTraceTicket first=ro_trace_begin(&paused);
  ROTraceRecord value;assert(first.valid && !ro_trace_read(&paused,0,&value));
  atomic_store(&paused.phase,6);ROTraceTicket nested=ro_trace_begin(&paused);
  ro_trace_publish(&paused,nested,22,2,8);
  assert(!ro_trace_read(&paused,0,&value) && ro_trace_read(&paused,1,&value));
  assert(value.phase==6 && value.displayID==2);
  ro_trace_stop(&paused);assert(ro_trace_in_flight(&paused)==1);
  assert(!ro_trace_begin(&paused).valid && ro_trace_in_flight(&paused)==1);
  ro_trace_publish(&paused,first,11,1,1);
  assert(ro_trace_in_flight(&paused)==0 && ro_trace_read(&paused,0,&value));
  assert(value.timeNS==11 && value.phase==3 && value.displayID==1);
  for(unsigned int n=0;n<1000;n++)assert(!ro_trace_begin(&paused).valid);
  assert(ro_trace_reserved(&paused)==2 && ro_trace_read(&paused,0,&value) && value.timeNS==11);

  // Concurrent immutable records cannot mix fields from different writers.
  ROTrace concurrent;ro_trace_init(&concurrent);pthread_t threads[16];Worker workers[16];
  for(unsigned int i=0;i<16;i++){workers[i]=(Worker){&concurrent,i+1};assert(!pthread_create(&threads[i],NULL,record_worker,&workers[i]));}
  for(unsigned int i=0;i<16;i++)assert(!pthread_join(threads[i],NULL));
  ro_trace_stop(&concurrent);assert(!ro_trace_in_flight(&concurrent));
  unsigned int count=ro_trace_reserved(&concurrent);assert(count<=64);
  for(unsigned int i=0;i<count;i++) {
    assert(ro_trace_read(&concurrent,i,&value));
    assert(value.displayID>=1 && value.displayID<=16 && value.flags<4);
    assert(value.timeNS==((uint64_t)value.displayID<<32|value.flags));
  }
  // Bounded contention may fail closed; it must never silently claim completeness.
  assert(count==64 || atomic_load(&concurrent.overflow));

  ROTrace full;ro_trace_init(&full);
  for(unsigned int i=0;i<RO_TRACE_CAPACITY;i++) {
    ROTraceTicket ticket=ro_trace_begin(&full);assert(ticket.valid);
    ro_trace_publish(&full,ticket,i+100,7,8);
  }
  assert(!ro_trace_begin(&full).valid && atomic_load(&full.overflow));
  assert(ro_trace_reserved(&full)==128 && !ro_trace_in_flight(&full));
  assert(ro_trace_read(&full,0,&value) && value.timeNS==100);
  assert(ro_trace_read(&full,127,&value) && value.timeNS==227);
  assert(!ro_trace_read(&full,128,&value));
  printf("{\"ok\":true,\"checks\":7,\"concurrentRecords\":%u,\"displayCalls\":0}\n",count);
  return 0;
}
