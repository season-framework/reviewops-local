#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>

// Pure NSObject lifetime regression. No AppKit, CoreGraphics or display API.
static unsigned int deallocations = 0;
@interface ProbeOwned : NSObject
@end
@implementation ProbeOwned
- (void)dealloc { deallocations++; }
@end
__attribute__((noinline)) static void failWithStrongParameter(ProbeOwned *value) {
  if (!value) abort();
  @throw [NSException exceptionWithName:@"ExpectedProbeFailure" reason:@"pure-object unwind" userInfo:nil];
}
int main(void) {
  @autoreleasepool {
    __strong ProbeOwned *owned = [ProbeOwned new];
    BOOL caught = NO;
    @try { failWithStrongParameter(owned); }
    @catch (NSException *exception) { caught = [exception.name isEqual:@"ExpectedProbeFailure"]; }
    @finally { owned = nil; }
    printf("{\"caught\":%s,\"deallocationsBeforePoolExit\":%u}\n", caught ? "true" : "false", deallocations);
    return caught ? 0 : 2;
  }
}
