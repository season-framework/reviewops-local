#import <Foundation/Foundation.h>

// Shared with the Foundation-only JSON round-trip fixture. A C logical
// expression has type int, so @(... && ...) would serialize as 1/0, not true/false.
static inline NSNumber *ROTopologyCompletionValue(BOOL stopped,unsigned int inFlight,
    NSUInteger ready,unsigned int reserved,BOOL overflow,BOOL clockFailed,
    BOOL observerFailed,BOOL outputFailed) {
  return stopped && inFlight==0 && ready==reserved && !overflow && !clockFailed &&
    !observerFailed && !outputFailed ? @YES : @NO;
}
