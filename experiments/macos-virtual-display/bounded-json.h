#import <Foundation/Foundation.h>
#include <stdio.h>

// Also exercised by a Foundation-only fixture: no display or AppKit calls.
static NSData *ROEncodeBoundedJSON(NSDictionary *value,NSUInteger limit,NSError **error) {
  NSData *bytes=nil;
  @try { bytes=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:error]; }
  @catch(NSException *exception) {
    (void)exception;
    if(error)*error=[NSError errorWithDomain:@"ReviewOpsProbeOutput" code:2 userInfo:@{NSLocalizedDescriptionKey:@"JSON encoding failed"}];
    return nil;
  }
  if (bytes && bytes.length>limit) {
    if(error)*error=[NSError errorWithDomain:@"ReviewOpsProbeOutput" code:1 userInfo:@{NSLocalizedDescriptionKey:@"JSON byte budget exceeded"}];
    return nil;
  }
  return bytes;
}
static BOOL ROWriteProbeJSON(NSDictionary *value,NSString *path,NSUInteger limit,
    NSString *failureCode,NSString *__strong *failure,NSUInteger *encodedSize) {
  NSError *error=nil;
  NSData *bytes=ROEncodeBoundedJSON(value,limit,&error);
  if(encodedSize)*encodedSize=bytes.length;
  if(bytes && [bytes writeToFile:path options:NSDataWritingAtomic error:&error])return YES;
  if(failure && !*failure)*failure=failureCode;
  // Explicit, bounded failure evidence; never pretend omitted raw data passed.
  NSMutableDictionary *fallback=[@{@"schema":@1,@"outcome":@"failed",@"outputCode":failureCode,
    @"rawReportOmitted":@YES} mutableCopy];
  for(NSString *key in @[@"source",@"runId",@"architecture",@"code",@"primaryCode",@"failurePhase",@"cleanupCode"])
    if(value[key])fallback[key]=value[key];
  if(!fallback[@"code"])fallback[@"code"]=failureCode;
  NSData *small=ROEncodeBoundedJSON(fallback,limit,NULL);
  if(!small || ![small writeToFile:path options:NSDataWritingAtomic error:NULL])
    fprintf(stderr,"Unable to persist bounded probe failure: %s\n",failureCode.UTF8String);
  return NO;
}
