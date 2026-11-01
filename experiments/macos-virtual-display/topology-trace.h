#ifndef REVIEWOPS_TOPOLOGY_TRACE_H
#define REVIEWOPS_TOPOLOGY_TRACE_H

// Pure C storage only. Initialize once before publishing the address; never
// reset/reuse/free it while a registered or late callback can hold that address.
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#define RO_TRACE_CAPACITY 128u

typedef struct {
  uint64_t timeNS;
  uint32_t displayID, flags, phase;
} ROTraceRecord;
typedef struct { atomic_bool ready; ROTraceRecord value; } ROTraceSlot;
typedef struct {
  atomic_bool accepting, overflow, clockFailed;
  atomic_uint inFlight, reserved, phase, rejectedAfterStop;
  ROTraceSlot slots[RO_TRACE_CAPACITY];
} ROTrace;
typedef struct { unsigned int index, phase; bool valid; } ROTraceTicket;

static inline void ro_trace_init(ROTrace *trace) {
  atomic_init(&trace->accepting, true);
  atomic_init(&trace->overflow, false);
  atomic_init(&trace->clockFailed, false);
  atomic_init(&trace->inFlight, 0);
  atomic_init(&trace->reserved, 0);
  atomic_init(&trace->phase, 0);
  atomic_init(&trace->rejectedAfterStop, 0);
  for (unsigned int i=0;i<RO_TRACE_CAPACITY;i++) atomic_init(&trace->slots[i].ready, false);
}
static inline bool ro_trace_lock_free(ROTrace *trace) {
  return atomic_is_lock_free(&trace->accepting) && atomic_is_lock_free(&trace->overflow) &&
    atomic_is_lock_free(&trace->clockFailed) && atomic_is_lock_free(&trace->inFlight) &&
    atomic_is_lock_free(&trace->reserved) && atomic_is_lock_free(&trace->phase) &&
    atomic_is_lock_free(&trace->rejectedAfterStop) && atomic_is_lock_free(&trace->slots[0].ready);
}
static inline void ro_trace_stop(ROTrace *trace) {
  atomic_store_explicit(&trace->accepting, false, memory_order_seq_cst);
}
static inline ROTraceTicket ro_trace_begin(ROTrace *trace) {
  // This handshake must be seq_cst across BOTH atomics: a writer that observed
  // accepting=true must be visible to shutdown's inFlight load until published.
  atomic_fetch_add_explicit(&trace->inFlight, 1, memory_order_seq_cst);
  if (!atomic_load_explicit(&trace->accepting, memory_order_seq_cst)) {
    atomic_fetch_add_explicit(&trace->rejectedAfterStop, 1, memory_order_relaxed);
    atomic_fetch_sub_explicit(&trace->inFlight, 1, memory_order_seq_cst);
    return (ROTraceTicket){.valid=false};
  }
  unsigned int index=atomic_load_explicit(&trace->reserved, memory_order_relaxed);
  // Bounded reservation attempts; never wrap, overwrite, wait, allocate or lock.
  for (unsigned int attempt=0;attempt<8 && index<RO_TRACE_CAPACITY;attempt++) {
    if (atomic_compare_exchange_weak_explicit(&trace->reserved,&index,index+1,
          memory_order_relaxed,memory_order_relaxed)) {
      return (ROTraceTicket){.index=index,.phase=atomic_load_explicit(&trace->phase,memory_order_relaxed),.valid=true};
    }
  }
  atomic_store_explicit(&trace->overflow,true,memory_order_relaxed);
  ro_trace_stop(trace);
  atomic_fetch_sub_explicit(&trace->inFlight,1,memory_order_seq_cst);
  return (ROTraceTicket){.valid=false};
}
static inline void ro_trace_publish(ROTrace *trace,ROTraceTicket ticket,
    uint64_t timeNS,uint32_t displayID,uint32_t flags) {
  if (!ticket.valid) return;
  ROTraceSlot *slot=&trace->slots[ticket.index];
  slot->value=(ROTraceRecord){.timeNS=timeNS,.displayID=displayID,.flags=flags,.phase=ticket.phase};
  atomic_store_explicit(&slot->ready,true,memory_order_release);
  atomic_fetch_sub_explicit(&trace->inFlight,1,memory_order_seq_cst);
}
static inline bool ro_trace_read(ROTrace *trace,unsigned int index,ROTraceRecord *out) {
  if (index>=RO_TRACE_CAPACITY || !atomic_load_explicit(&trace->slots[index].ready,memory_order_acquire)) return false;
  // A ready slot is immutable forever. Never inspect a reserved, unready value.
  *out=trace->slots[index].value;
  return true;
}
static inline unsigned int ro_trace_reserved(ROTrace *trace) {
  return atomic_load_explicit(&trace->reserved,memory_order_relaxed);
}
static inline unsigned int ro_trace_in_flight(ROTrace *trace) {
  return atomic_load_explicit(&trace->inFlight,memory_order_seq_cst);
}
#endif
