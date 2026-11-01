#import "../../experiments/macos-virtual-display/bounded-json.h"
#include <assert.h>

int main(int argc,const char *argv[]) {
  @autoreleasepool {
    assert(argc==2);NSString *folder=[NSString stringWithUTF8String:argv[1]];
    NSString *clock=@"18446744073709551615",*source=[@"a" stringByPaddingToLength:40 withString:@"a" startingAtIndex:0];
    NSDictionary *display=@{@"id":@4294967295u,@"bounds":@{@"x":@(-1.7976931348623157e308),@"y":@1.7976931348623157e308,@"width":@1.7976931348623157e308,@"height":@1.7976931348623157e308},@"online":@1,@"active":@1,@"mirrored":@0,@"main":@1,@"builtin":@1,@"vendor":@4294967295u,@"product":@4294967295u,@"serial":@4294967295u,@"mirrorParent":@4294967295u,@"hardwareMirrorPrimary":@4294967295u,@"modeAvailable":@YES,@"modeWidth":@18446744073709551615ull,@"modeHeight":@18446744073709551615ull,@"pixelWidth":@18446744073709551615ull,@"pixelHeight":@18446744073709551615ull,@"refreshRate":@1.7976931348623157e308};
    NSDictionary *query=@{@"startNS":clock,@"endNS":clock,@"sequenceBefore":@128,@"sequenceAfter":@128,@"inFlightBefore":@128,@"inFlightAfter":@128,@"objectIDBefore":@4294967295u,@"objectIDAfter":@4294967295u};
    NSMutableArray *inventory=[NSMutableArray array],*modes=[NSMutableArray array],*cleanup=[NSMutableArray array],*events=[NSMutableArray array],*stages=[NSMutableArray array],*ids=[NSMutableArray array];
    // Deliberately exceed the helper's <16-online limit by one for this size bound.
    for(unsigned int i=0;i<16;i++){[inventory addObject:display];[ids addObject:@4294967295u];}
    for(unsigned int i=0;i<16;i++){[modes addObject:@{@"elapsedSeconds":@1.7976931348623157e308,@"display":display,@"query":query}];[cleanup addObject:@{@"elapsedSeconds":@1.7976931348623157e308,@"state":@{@"ownedIdPresent":@YES,@"ownedModeAvailable":@YES,@"preexistingMatches":@NO}}];}
    NSDictionary *observation=@{@"query":query,@"onlineIds":ids,@"preexistingMatches":@YES,@"existingInventoryReference":@"native.before",@"owned":display};
    for(unsigned int i=0;i<8;i++){NSMutableDictionary *s=[observation mutableCopy];s[@"stage"]=@"baseline-confirmed";[stages addObject:s];}
    for(unsigned int i=0;i<128;i++)[events addObject:@[@(i+1),clock,@4294967295u,@4294967295u,@11]];
    NSMutableDictionary *trace=[@{@"schema":@1,@"source":source,@"runId":@"ffffffff-ffff-ffff-ffff-ffffffffffff",@"events":events,@"stages":stages,@"firstModeQuery":observation,@"lastModeQuery":observation,@"firstCleanupQuery":observation,@"lastCleanupQuery":observation,@"cutoffMeaning":@"Ready immutable slots at this snapshot; rejected late callbacks can still occur until process exit.",@"phases":@{@"0":@"registration",@"11":@"observer-stop"}} mutableCopy];
    NSMutableDictionary *native=[@{@"schema":@1,@"source":source,@"runId":@"ffffffff-ffff-ffff-ffff-ffffffffffff",@"architecture":@"arm64",@"outcome":@"failed",@"code":@"PREEXISTING_DISPLAYS_CHANGED_DURING_MODE_TRANSITION",@"primaryCode":@"PREEXISTING_DISPLAYS_CHANGED_DURING_MODE_TRANSITION",@"phase":@"complete",@"before":inventory,@"during":inventory,@"lastDuring":inventory,@"afterWindow":inventory,@"lastCleanup":inventory,@"after":inventory,@"modeObservations":modes,@"cleanupObservations":cleanup,@"topologyDiagnostics":@{@"file":@"reconfiguration.json",@"registered":@YES,@"stopped":@YES,@"reserved":@128,@"ready":@128,@"completeAtCutoff":@YES}} mutableCopy];
    native[@"firstCleanupInventory"]=inventory;
    // Extra margin for all fixed metadata, including the complete phase map,
    // timestamps and diagnostics summary, beyond the maximal variable arrays.
    trace[@"reservedMetadataSpace"]=[@"x" stringByPaddingToLength:8*1024 withString:@"x" startingAtIndex:0];
    native[@"reservedMetadataSpace"]=[@"x" stringByPaddingToLength:16*1024 withString:@"x" startingAtIndex:0];
    NSString *failure=nil;NSUInteger nativeBytes=0,traceBytes=0;
    assert(ROWriteProbeJSON(native,[folder stringByAppendingPathComponent:@"native.json"],128*1024,@"NATIVE_JSON_WRITE_OR_BUDGET_FAILED",&failure,&nativeBytes));assert(!failure);
    assert(ROWriteProbeJSON(trace,[folder stringByAppendingPathComponent:@"trace.json"],32*1024,@"TOPOLOGY_JSON_WRITE_OR_BUDGET_FAILED",&failure,&traceBytes));assert(!failure);
    // Output overflow and invalid encodings persist explicit failed fallbacks;
    // a primary lifecycle failure always survives the secondary output failure.
    native[@"oversized"]=[@"x" stringByPaddingToLength:128*1024 withString:@"x" startingAtIndex:0];
    NSString *path=[folder stringByAppendingPathComponent:@"overflow.json"];
    assert(!ROWriteProbeJSON(native,path,128*1024,@"OUTPUT_LIMIT",&failure,NULL));
    NSDictionary *fallback=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:NULL];
    assert([fallback[@"primaryCode"] isEqual:@"PREEXISTING_DISPLAYS_CHANGED_DURING_MODE_TRANSITION"] && [fallback[@"outcome"] isEqual:@"failed"] && [fallback[@"rawReportOmitted"] boolValue]);
    trace[@"oversized"]=[@"x" stringByPaddingToLength:32*1024 withString:@"x" startingAtIndex:0];
    assert(!ROWriteProbeJSON(trace,[folder stringByAppendingPathComponent:@"trace-overflow.json"],32*1024,@"TRACE_OUTPUT_LIMIT",&failure,NULL));
    assert([failure isEqual:@"OUTPUT_LIMIT"]); // sticky first output failure
    assert(!ROWriteProbeJSON(@{@"invalid":[NSObject new]},[folder stringByAppendingPathComponent:@"invalid.json"],1024,@"INVALID_JSON",&failure,NULL));
    assert(!ROWriteProbeJSON(@{@"schema":@1},[folder stringByAppendingPathComponent:@"missing/denied.json"],1024,@"IO_FAILED",&failure,NULL));
    printf("{\"ok\":true,\"checks\":6,\"nativeBytes\":%lu,\"traceBytes\":%lu,\"displayCalls\":0}\n",(unsigned long)nativeBytes,(unsigned long)traceBytes);
    return 0;
  }
}
