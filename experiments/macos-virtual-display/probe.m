// Private-API lifecycle experiment, never a shipping ReviewOps provider.
#import "private-interface.h"
#import "bounded-json.h"
#include "topology-trace.h"
#import <objc/runtime.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

#ifndef REVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION
#define REVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION 0
#endif

static volatile sig_atomic_t interrupted = 0;
static void stopProbe(int signalNumber) { (void)signalNumber; interrupted = 1; }
static NSString *outputPath;
static NSMutableDictionary *report;
// Static, process-lifetime userdata is NEVER freed/reset/reused, even if Quartz
// delivers an in-flight callback after Remove returns. It owns no ObjC objects.
static ROTrace topologyTrace;
static BOOL observerInitialized=NO,observerRegistered=NO,observerStopped=NO;
static NSString *observerFailure,*nativeOutputFailure,*traceOutputFailure;
static NSMutableDictionary *topology;
static NSMutableArray *topologyStages;
static NSArray *cutoffEvents;
static unsigned int cutoffReserved,cutoffInFlight,cutoffRejected;
static BOOL cutoffOverflow,cutoffClockFailed;
static void saveDiagnostics(void);
static void checkDiagnosticHealth(void);
static void noteFailure(NSString *code,NSString *field) {
  report[field]=code; report[@"outcome"]=@"failed";
  if(!report[@"code"])report[@"code"]=code;
  if(!report[@"primaryCode"])report[@"primaryCode"]=report[@"code"];
  if(!report[@"failurePhase"])report[@"failurePhase"]=report[@"phase"] ?: @"baseline";
}
static void saveReport(void) {
  if(observerInitialized)saveDiagnostics();
  ROWriteProbeJSON(report,outputPath,128*1024,@"NATIVE_JSON_WRITE_OR_BUDGET_FAILED",&nativeOutputFailure,NULL);
}
static void fail(NSString *code) {
  @throw [NSException exceptionWithName:@"ProbeFailure" reason:code userInfo:nil];
}
static uint64_t monotonicNS(void) {
  struct timespec now;
  if(clock_gettime(CLOCK_MONOTONIC_RAW,&now)) {
    if(observerInitialized)atomic_store_explicit(&topologyTrace.clockFailed,true,memory_order_relaxed);
    return 0;
  }
  return (uint64_t)now.tv_sec*1000000000ull+(uint64_t)now.tv_nsec;
}
static void displayReconfigured(CGDirectDisplayID display,CGDisplayChangeSummaryFlags flags,void *userInfo) {
  if(userInfo!=&topologyTrace)return;
  ROTraceTicket ticket=ro_trace_begin(&topologyTrace);
  if(!ticket.valid)return;
  // No Foundation, getters, I/O, exceptions, waits or configuration in callback.
  struct timespec now;
  uint64_t stamp=0;
  if(clock_gettime(CLOCK_MONOTONIC_RAW,&now))atomic_store_explicit(&topologyTrace.clockFailed,true,memory_order_relaxed);
  else stamp=(uint64_t)now.tv_sec*1000000000ull+(uint64_t)now.tv_nsec;
  ro_trace_publish(&topologyTrace,ticket,stamp,display,flags);
}
static void diagnosticPhase(unsigned int phase) {
  if(observerInitialized)atomic_store_explicit(&topologyTrace.phase,phase,memory_order_relaxed);
}
static NSArray *readyEvents(unsigned int reserved) {
  NSMutableArray *events=[NSMutableArray array];
  for(unsigned int i=0;i<reserved;i++) {
    ROTraceRecord value;
    if(ro_trace_read(&topologyTrace,i,&value))
      [events addObject:@[@(i+1),[NSString stringWithFormat:@"%llu",(unsigned long long)value.timeNS],@(value.displayID),@(value.flags),@(value.phase)]];
  }
  return events;
}
static void saveDiagnostics(void) {
  // Closed reports use one immutable cutoff. Late rejected callbacks may still
  // alter atomic counters, but cannot rewrite this snapshot or admitted payload.
  unsigned int reserved=observerStopped?cutoffReserved:ro_trace_reserved(&topologyTrace);
  NSArray *events=observerStopped?cutoffEvents:readyEvents(reserved);
  unsigned int inFlight=observerStopped?cutoffInFlight:ro_trace_in_flight(&topologyTrace);
  BOOL overflow=observerStopped?cutoffOverflow:atomic_load_explicit(&topologyTrace.overflow,memory_order_relaxed);
  BOOL clockFailed=observerStopped?cutoffClockFailed:atomic_load_explicit(&topologyTrace.clockFailed,memory_order_relaxed);
  topology[@"events"]=events;topology[@"reserved"]=@(reserved);topology[@"ready"]=@(events.count);
  topology[@"inFlightAtSnapshot"]=@(inFlight);
  topology[@"rejectedAfterStopAtSnapshot"]=@(observerStopped?cutoffRejected:atomic_load_explicit(&topologyTrace.rejectedAfterStop,memory_order_relaxed));
  topology[@"overflow"]=@(overflow);topology[@"clockFailed"]=@(clockFailed);
  topology[@"cutoffMeaning"]=@"Ready immutable slots at this snapshot; rejected late callbacks can still occur until process exit.";
  topology[@"completeAtCutoff"]=@(observerStopped && inFlight==0 && events.count==reserved && !overflow && !clockFailed && !observerFailure && !traceOutputFailure);
  NSString *path=[outputPath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"reconfiguration.json"];
  if(observerFailure)topology[@"failureCode"]=observerFailure;
  ROWriteProbeJSON(topology,path,32*1024,@"TOPOLOGY_JSON_WRITE_OR_BUDGET_FAILED",&traceOutputFailure,NULL);
  report[@"topologyDiagnostics"]=@{@"file":@"reconfiguration.json",@"registered":@(observerRegistered),@"stopped":@(observerStopped),@"reserved":@(reserved),@"ready":@(events.count),@"completeAtCutoff":topology[@"completeAtCutoff"]};
}
static void checkDiagnosticHealth(void) {
  NSString *code=nativeOutputFailure ?: traceOutputFailure ?: observerFailure;
  if(!code && atomic_load_explicit(&topologyTrace.overflow,memory_order_relaxed))code=@"DISPLAY_CALLBACK_RECORD_LIMIT";
  if(!code && atomic_load_explicit(&topologyTrace.clockFailed,memory_order_relaxed))code=@"DISPLAY_CALLBACK_CLOCK_FAILED";
  if(code)fail(code);
}
static void startObserver(void) {
  ro_trace_init(&topologyTrace);observerInitialized=YES;
  topologyStages=[NSMutableArray array];
  topology=[@{@"schema":@1,@"source":report[@"source"],@"runId":report[@"runId"],
    @"eventFields":@[@"sequence",@"monotonicRawNS",@"displayID",@"rawFlags",@"phase"],
    @"recordLimitMeaning":@"capacity or bounded reservation attempts; no overwrite or unbounded retry loop",
    @"phases":@{@"0":@"registration",@"1":@"baseline",@"2":@"before-init",@"3":@"init",@"4":@"after-init",@"5":@"before-apply",@"6":@"apply",@"7":@"after-apply",@"8":@"mode-poll-and-window",@"9":@"release",@"10":@"cleanup",@"11":@"observer-stop"},
    @"stages":topologyStages,@"ownerToken":report[@"runId"],@"userdataLifetime":@"static until process exit; never retains display object"} mutableCopy];
  if(!ro_trace_lock_free(&topologyTrace)){observerFailure=@"DISPLAY_CALLBACK_ATOMICS_NOT_LOCK_FREE";fail(observerFailure);}
  CGError result=CGDisplayRegisterReconfigurationCallback(displayReconfigured,&topologyTrace);
  topology[@"registrationError"]=@(result);observerRegistered=result==kCGErrorSuccess;
  if(!observerRegistered){ro_trace_stop(&topologyTrace);observerFailure=@"DISPLAY_CALLBACK_REGISTRATION_FAILED";fail(observerFailure);}
}
static void finishObserver(void) {
  if(!observerInitialized)return;
  diagnosticPhase(11);ro_trace_stop(&topologyTrace);
  if(observerRegistered) {
    CGError result=CGDisplayRemoveReconfigurationCallback(displayReconfigured,&topologyTrace);
    topology[@"removalError"]=@(result);
    if(result!=kCGErrorSuccess && !observerFailure)observerFailure=@"DISPLAY_CALLBACK_REMOVAL_FAILED";
  }
  // Do not assume removal drained in-flight callbacks. Static userdata stays
  // alive; only ready acquire-published slots may be read, including on failure.
  topology[@"cutoffStartNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
  cutoffInFlight=ro_trace_in_flight(&topologyTrace);cutoffReserved=ro_trace_reserved(&topologyTrace);
  cutoffEvents=[readyEvents(cutoffReserved) copy];
  cutoffRejected=atomic_load_explicit(&topologyTrace.rejectedAfterStop,memory_order_relaxed);
  cutoffOverflow=atomic_load_explicit(&topologyTrace.overflow,memory_order_relaxed);
  topology[@"cutoffEndNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
  cutoffClockFailed=atomic_load_explicit(&topologyTrace.clockFailed,memory_order_relaxed);observerStopped=YES;
  if((cutoffInFlight || cutoffEvents.count!=cutoffReserved) && !observerFailure)observerFailure=@"DISPLAY_CALLBACK_INCOMPLETE_AT_CUTOFF";
  if(cutoffOverflow && !observerFailure)observerFailure=@"DISPLAY_CALLBACK_RECORD_LIMIT";
  if(cutoffClockFailed && !observerFailure)observerFailure=@"DISPLAY_CALLBACK_CLOCK_FAILED";
  if(observerFailure)noteFailure(observerFailure,@"observerCode");
}
static NSString *executionRefusal(void) {
#if !REVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION
  return @"LOCAL_BUILD_CANNOT_CREATE_DISPLAYS";
#else
  NSDictionary *required = @{@"GITHUB_ACTIONS":@"true", @"CI":@"true", @"RUNNER_ENVIRONMENT":@"github-hosted", @"RUNNER_OS":@"macOS", @"GITHUB_REPOSITORY":@"season-framework/reviewops-local", @"GITHUB_REF":@"refs/heads/codex/macos-virtual-display-prototype", @"GITHUB_EVENT_NAME":@"push"};
  NSDictionary *env = NSProcessInfo.processInfo.environment;
  for (NSString *name in required) if (![env[name] isEqual:required[name]]) return [@"EXECUTION_GATE_" stringByAppendingString:name];
  NSString *source = env[@"GITHUB_SHA"];
  NSCharacterSet *nonHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  if (source.length != 40 || [source rangeOfCharacterFromSet:nonHex].location != NSNotFound) return @"EXECUTION_GATE_GITHUB_SHA";
  if (![[NSUUID alloc] initWithUUIDString:env[@"REVIEWOPS_PROBE_RUN_ID"]]) return @"EXECUTION_GATE_RUN_ID";
  return nil;
#endif
}
static NSDictionary *bounds(CGRect rect) {
  return @{@"x":@(rect.origin.x), @"y":@(rect.origin.y), @"width":@(rect.size.width), @"height":@(rect.size.height)};
}
static NSArray *inventoryForOwned(uint32_t pendingOwnedId) {
  CGDirectDisplayID ids[16]; uint32_t count = 0;
  if (CGGetOnlineDisplayList(16, ids, &count) != kCGErrorSuccess || count >= 16) fail(@"DISPLAY_INVENTORY_UNAVAILABLE_OR_TOO_LARGE");
  NSMutableArray *items = [NSMutableArray array];
  for (uint32_t i = 0; i < count; i++) {
    CGDirectDisplayID ident = ids[i]; CGDisplayModeRef mode = CGDisplayCopyDisplayMode(ident);
    if (!mode) {
      report[@"unavailableModeDisplayId"] = @(ident);
      report[@"unavailableModeWasOwned"] = ident == pendingOwnedId ? @YES : @NO;
      report[@"unavailableModePhase"] = report[@"phase"] ?: @"baseline";
      if (ident != pendingOwnedId) { saveReport(); fail(@"PREEXISTING_DISPLAY_MODE_UNAVAILABLE"); }
    }
    [items addObject:@{
      @"id":@(ident), @"bounds":bounds(CGDisplayBounds(ident)),
      @"online":@(CGDisplayIsOnline(ident)), @"active":@(CGDisplayIsActive(ident)),
      @"mirrored":@(CGDisplayIsInMirrorSet(ident)), @"main":@(CGDisplayIsMain(ident)),
      @"mirrorParent":@(CGDisplayMirrorsDisplay(ident)), @"hardwareMirrorPrimary":@(CGDisplayPrimaryDisplay(ident)),
      @"builtin":@(CGDisplayIsBuiltin(ident)), @"vendor":@(CGDisplayVendorNumber(ident)),
      @"product":@(CGDisplayModelNumber(ident)), @"serial":@(CGDisplaySerialNumber(ident)),
      @"modeAvailable":mode ? @YES : @NO,
      @"modeWidth":mode ? @(CGDisplayModeGetWidth(mode)) : NSNull.null,
      @"modeHeight":mode ? @(CGDisplayModeGetHeight(mode)) : NSNull.null,
      @"pixelWidth":mode ? @(CGDisplayModeGetPixelWidth(mode)) : NSNull.null,
      @"pixelHeight":mode ? @(CGDisplayModeGetPixelHeight(mode)) : NSNull.null,
      @"refreshRate":mode ? @(CGDisplayModeGetRefreshRate(mode)) : NSNull.null
    }];
    if (mode) CGDisplayModeRelease(mode);
  }
  return [items sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"id"] compare:b[@"id"]]; }];
}
static NSArray *inventory(void) { return inventoryForOwned(0); }
static BOOL preserves(NSArray *before, NSArray *after, uint32_t ownedId) {
  NSMutableArray *retained = [NSMutableArray array];
  for (NSDictionary *item in after) if ([item[@"id"] unsignedIntValue] != ownedId) [retained addObject:item];
  return [before isEqual:retained];
}
static NSDictionary *findDisplay(NSArray *items, uint32_t ident) {
  for (NSDictionary *item in items) if ([item[@"id"] unsignedIntValue] == ident) return item;
  return nil;
}
typedef struct { uint64_t start; unsigned int sequence,inFlight; } ROQuery;
static ROQuery beginQuery(void) {
  return (ROQuery){.start=monotonicNS(),.sequence=ro_trace_reserved(&topologyTrace),.inFlight=ro_trace_in_flight(&topologyTrace)};
}
static NSDictionary *endQuery(ROQuery query,uint32_t objectBefore,uint32_t objectAfter) {
  return @{@"startNS":[NSString stringWithFormat:@"%llu",(unsigned long long)query.start],
    @"endNS":[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()],
    @"sequenceBefore":@(query.sequence),@"sequenceAfter":@(ro_trace_reserved(&topologyTrace)),
    @"inFlightBefore":@(query.inFlight),@"inFlightAfter":@(ro_trace_in_flight(&topologyTrace)),
    @"objectIDBefore":@(objectBefore),@"objectIDAfter":@(objectAfter)};
}
static NSDictionary *queryObservation(NSArray *current,NSArray *before,uint32_t ownedId,NSDictionary *query,NSString *mismatchReference) {
  NSMutableArray *ids=[NSMutableArray array];for(NSDictionary *item in current)[ids addObject:item[@"id"]];
  BOOL matches=preserves(before,current,ownedId);
  return @{@"query":query,@"onlineIds":ids,@"preexistingMatches":@(matches),
    @"existingInventoryReference":matches?@"native.before":mismatchReference,
    @"owned":findDisplay(current,ownedId) ?: NSNull.null};
}
static void recordStage(NSString *name,NSArray *current,NSArray *before,uint32_t ownedId,NSDictionary *query) {
  report[@"lastDuring"]=current;
  if(topologyStages.count>=8){if(!observerFailure)observerFailure=@"DISPLAY_STAGE_RECORD_LIMIT";return;}
  NSMutableDictionary *value=[queryObservation(current,before,ownedId,query,@"native.lastDuring") mutableCopy];value[@"stage"]=name;
  [topologyStages addObject:value];saveReport();
}
static void verifyOwnedObservation(NSArray *before,NSArray *current,uint32_t ownedId,
    uint32_t objectBefore,uint32_t objectAfter,unsigned int serial) {
  // Preserve the original display guard's priority over diagnostic failures.
  if(!preserves(before,current,ownedId))fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_CREATION");
  if(!ownedId || objectBefore!=ownedId || objectAfter!=ownedId || findDisplay(before,ownedId))fail(@"OWNED_DISPLAY_ID_CHANGED");
  NSDictionary *owned=findDisplay(current,ownedId);
  if(owned && ([owned[@"vendor"] unsignedIntValue]!=505 || [owned[@"serial"] unsignedIntValue]!=serial))fail(@"OWNED_DISPLAY_IDENTITY_MISMATCH");
  checkDiagnosticHealth();
}
static BOOL waitUntil(NSTimeInterval seconds, BOOL (^condition)(void)) {
  NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + seconds;
  while (!interrupted && NSProcessInfo.processInfo.systemUptime < deadline) {
    if (condition()) return YES;
    @autoreleasepool { [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; }
  }
  return NO;
}
static BOOL signature(Class type, NSString *selector, const char *result, NSArray<NSString *> *arguments) {
  Method method = class_getInstanceMethod(type, NSSelectorFromString(selector));
  if (!method) return NO;
  NSMethodSignature *s = [NSMethodSignature signatureWithObjCTypes:method_getTypeEncoding(method)];
  if (!s) return NO;
  if (strcmp(s.methodReturnType, result) || s.numberOfArguments != arguments.count + 2) return NO;
  for (NSUInteger i = 0; i < arguments.count; i++) if (strcmp([s getArgumentTypeAtIndex:i+2], arguments[i].UTF8String)) return NO;
  return YES;
}
static BOOL privateABI(void) {
  Class descriptor = NSClassFromString(@"CGVirtualDisplayDescriptor"), display = NSClassFromString(@"CGVirtualDisplay"), mode = NSClassFromString(@"CGVirtualDisplayMode"), settings = NSClassFromString(@"CGVirtualDisplaySettings");
  if (!descriptor || !display || !mode || !settings) return NO;
  for (Class type in @[descriptor, display, mode, settings]) if (!signature(type, @"init", @encode(id), @[])) return NO;
  for (NSString *name in @[@"setName:", @"setQueue:"]) if (!signature(descriptor, name, @encode(void), @[@"@"])) return NO;
  for (NSString *name in @[@"setMaxPixelsWide:", @"setMaxPixelsHigh:", @"setVendorID:", @"setProductID:", @"setSerialNum:"]) if (!signature(descriptor, name, @encode(void), @[@"I"])) return NO;
  if (!signature(descriptor, @"setSizeInMillimeters:", @encode(void), @[[NSString stringWithUTF8String:@encode(CGSize)]])) return NO;
  for (NSString *name in @[@"setRedPrimary:", @"setGreenPrimary:", @"setBluePrimary:", @"setWhitePoint:"]) if (!signature(descriptor, name, @encode(void), @[[NSString stringWithUTF8String:@encode(CGPoint)]])) return NO;
  return signature(display, @"initWithDescriptor:", @encode(id), @[@"@"]) && signature(display, @"applySettings:", @encode(BOOL), @[@"@"]) && signature(display, @"displayID", @encode(unsigned int), @[]) && signature(mode, @"initWithWidth:height:refreshRate:", @encode(id), @[@"I", @"I", @"d"]) && signature(settings, @"setModes:", @encode(void), @[@"@"]) && signature(settings, @"setHiDPI:", @encode(void), @[@"I"]);
}
static BOOL requestedState(NSDictionary *item) {
  NSDictionary *rect = item[@"bounds"];
  return [item[@"modeAvailable"] boolValue] && [item[@"modeWidth"] intValue] == 1920 &&
         [item[@"modeHeight"] intValue] == 1080 && [item[@"pixelWidth"] intValue] == 1920 &&
         [item[@"pixelHeight"] intValue] == 1080 && [rect[@"width"] intValue] == 1920 &&
         [rect[@"height"] intValue] == 1080;
}
static NSArray *observeOwnedMode(id<ROVirtualDisplay> display, uint32_t ownedId, unsigned int serial, NSArray *before) {
  NSTimeInterval start = NSProcessInfo.processInfo.systemUptime, deadline = start + 15;
  NSMutableArray *observations = [NSMutableArray array];
  report[@"modeObservations"] = observations; report[@"phase"] = @"owned-mode-pending";
  report[@"modeWaitBudgetSeconds"] = @15; unsigned int polls = 0;
  diagnosticPhase(8);
  while (!interrupted && NSProcessInfo.processInfo.systemUptime < deadline) {
    ROQuery mark=beginQuery();uint32_t objectBefore=display.displayID;
    NSArray *current = inventoryForOwned(ownedId);
    uint32_t objectAfter=display.displayID;NSDictionary *query=endQuery(mark,objectBefore,objectAfter);
    NSDictionary *observedQuery=queryObservation(current,before,ownedId,query,@"native.lastDuring");
    if(!topology[@"firstModeQuery"])topology[@"firstModeQuery"]=observedQuery;
    topology[@"lastModeQuery"]=observedQuery;
    report[@"lastDuring"] = current;
    report[@"modePollCount"] = @(++polls);
    report[@"modeWaitElapsedSeconds"] = @(NSProcessInfo.processInfo.systemUptime - start);
    if (!preserves(before, current, ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_MODE_TRANSITION");
    if(objectBefore!=ownedId || objectAfter!=ownedId)fail(@"OWNED_MODE_WRITE_IDENTITY_REFUSED");
    checkDiagnosticHealth();
    NSDictionary *owned = findDisplay(current, ownedId);
    id observed = owned ?: NSNull.null;
    if (![observations.lastObject[@"display"] isEqual:observed] && observations.count < 16) {
      [observations addObject:@{@"elapsedSeconds":report[@"modeWaitElapsedSeconds"], @"display":observed,@"query":query}]; saveReport();checkDiagnosticHealth();
    }
    if (owned && [owned[@"online"] boolValue] && [owned[@"active"] boolValue]) {
      if (display.displayID != ownedId || findDisplay(before, ownedId)) fail(@"OWNED_MODE_WRITE_IDENTITY_REFUSED");
      if ([owned[@"mirrored"] boolValue] || CGDisplayMirrorsDisplay(ownedId) != kCGNullDirectDisplay) fail(@"OWNED_MIRRORED_DISPLAY_REFUSED");
      if ([owned[@"vendor"] unsignedIntValue] == 505 && [owned[@"serial"] unsignedIntValue] == serial) {
        if (requestedState(owned)) { report[@"modeWaitCompleted"] = @YES; return current; }
      }
    }
    @autoreleasepool { [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; }
  }
  report[@"modeWaitElapsedSeconds"] = @(NSProcessInfo.processInfo.systemUptime - start);
  fail(@"OWNED_REQUESTED_MODE_TIMEOUT"); return nil;
}
static NSDictionary *placeOwnedWindow(uint32_t ownedId) {
  [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  __block NSScreen *target = nil;
  if (!waitUntil(5, ^BOOL{ for (NSScreen *candidate in NSScreen.screens) if ([candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == ownedId) { target = candidate; return YES; } return NO; })) fail(@"OWNED_NSSCREEN_NOT_OBSERVED");
  NSRect frame = NSMakeRect(target.frame.origin.x + 32, target.frame.origin.y + 32, 320, 180);
  NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO screen:target];
  window.releasedWhenClosed = NO; window.title = @"ReviewOps isolated virtual-display lifecycle probe";
  @try {
    [window setFrame:frame display:YES]; [window orderFrontRegardless];
    BOOL placed = waitUntil(3, ^BOOL{ return window.windowNumber > 0 && [window.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == ownedId && NSContainsRect(target.frame, window.frame) && window.visible; });
    NSDictionary *value = @{@"verified":@(placed), @"displayId":@(ownedId), @"observedScreenId":window.screen.deviceDescription[@"NSScreenNumber"] ?: @0, @"windowNumber":@(window.windowNumber), @"ownerPid":@(getpid()), @"frame":bounds(NSRectToCGRect(window.frame)), @"screenFrame":bounds(NSRectToCGRect(target.frame)), @"osFrameCapture":@NO, @"input":@NO};
    if (!placed) fail(@"OWNED_WINDOW_PLACEMENT_FAILED");
    return value;
  } @finally { [window orderOut:nil]; [window close]; }
}
static int exercise(void) {
  __strong id<ROVirtualDisplay> display = nil;
  NSArray *before = nil; uint32_t ownedId = 0; BOOL initialized = NO;
  @try {
    startObserver();diagnosticPhase(1);
    ROQuery mark=beginQuery();before = inventory(); report[@"before"] = before; report[@"phase"] = @"baseline";
    recordStage(@"baseline-first",before,before,0,endQuery(mark,0,0));checkDiagnosticHealth();
    @autoreleasepool { [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; }
    mark=beginQuery();NSArray *baselineAgain=inventory();
    recordStage(@"baseline-confirmed",baselineAgain,before,0,endQuery(mark,0,0));
    if(!preserves(before,baselineAgain,0))fail(@"PREEXISTING_DISPLAYS_CHANGED_BEFORE_CREATION");
    checkDiagnosticHealth();
    if (!privateABI()) { report[@"outcome"] = @"unsupported"; fail(@"PRIVATE_API_OR_ABI_UNAVAILABLE"); }
    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor"), displayClass = NSClassFromString(@"CGVirtualDisplay"), settingsClass = NSClassFromString(@"CGVirtualDisplaySettings"), modeClass = NSClassFromString(@"CGVirtualDisplayMode");
    id<ROVirtualDescriptor> descriptor = [descriptorClass new];
    [descriptor setName:[@"ReviewOps disposable CI " stringByAppendingString:NSUUID.UUID.UUIDString]];
    [descriptor setQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)];
    [descriptor setMaxPixelsWide:1920]; [descriptor setMaxPixelsHigh:1080];
    [descriptor setVendorID:505]; [descriptor setProductID:0];
    unsigned int serial = arc4random_uniform(0x7ffffffe) + 1;
    report[@"requestedIdentity"] = @{@"vendor":@505, @"serial":@(serial)};
    [descriptor setSerialNum:serial];
    if (signature(descriptorClass, @"setSerialNumber:", @encode(void), @[@"I"])) [descriptor setSerialNumber:serial];
    [descriptor setSizeInMillimeters:CGSizeMake(508, 285.75)];
    [descriptor setWhitePoint:CGPointMake(0.3125, 0.3291)]; [descriptor setRedPrimary:CGPointMake(0.6797, 0.3203)]; [descriptor setGreenPrimary:CGPointMake(0.2559, 0.6983)]; [descriptor setBluePrimary:CGPointMake(0.1494, 0.0557)];
    diagnosticPhase(2);mark=beginQuery();NSArray *beforeInit=inventory();
    recordStage(@"before-init",beforeInit,before,0,endQuery(mark,0,0));
    if(!preserves(before,beforeInit,0))fail(@"PREEXISTING_DISPLAYS_CHANGED_BEFORE_CREATION");
    checkDiagnosticHealth();
    report[@"phase"] = @"creating-owned-display"; saveReport();checkDiagnosticHealth();
    diagnosticPhase(3);topology[@"initStartNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
    display = [[displayClass alloc] initWithDescriptor:descriptor];
    topology[@"initEndNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
    topology[@"initReturnedObject"]=@(display!=nil);
    if (!display) fail(@"OWNED_DISPLAY_CREATION_FAILED");
    initialized = YES; ownedId = display.displayID; report[@"createdDisplays"] = @1; report[@"ownedDisplayId"] = @(ownedId);topology[@"returnedOwnedId"]=@(ownedId);saveReport();
    if (!ownedId || findDisplay(before, ownedId)) fail(@"OWNED_DISPLAY_ID_INVALID_OR_PREEXISTING");
    diagnosticPhase(4);mark=beginQuery();uint32_t objectBefore=display.displayID;
    NSArray *afterInit=inventoryForOwned(ownedId);uint32_t objectAfter=display.displayID;
    recordStage(@"after-init",afterInit,before,ownedId,endQuery(mark,objectBefore,objectAfter));
    // A constructor-side existing-display change must prevent applySettings.
    verifyOwnedObservation(before,afterInit,ownedId,objectBefore,objectAfter,serial);
    id<ROVirtualSettings> settings = [settingsClass new]; [settings setHiDPI:0];
    id<ROVirtualMode> mode = [[modeClass alloc] initWithWidth:1920 height:1080 refreshRate:60];
    if (!mode) fail(@"OWNED_MODE_CREATION_FAILED");
    [settings setModes:@[mode]];
    diagnosticPhase(5);mark=beginQuery();objectBefore=display.displayID;
    NSArray *beforeApply=inventoryForOwned(ownedId);objectAfter=display.displayID;
    recordStage(@"before-apply",beforeApply,before,ownedId,endQuery(mark,objectBefore,objectAfter));
    verifyOwnedObservation(before,beforeApply,ownedId,objectBefore,objectAfter,serial);
    diagnosticPhase(6);topology[@"applyStartNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
    report[@"settingsApplyCalls"]=@1;BOOL accepted=[display applySettings:settings];
    topology[@"applyEndNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];topology[@"settingsAccepted"]=@(accepted);
    if(!accepted)fail(@"OWNED_SETTINGS_REJECTED");
    diagnosticPhase(7);mark=beginQuery();objectBefore=display.displayID;
    NSArray *afterApply=inventoryForOwned(ownedId);objectAfter=display.displayID;
    recordStage(@"after-apply",afterApply,before,ownedId,endQuery(mark,objectBefore,objectAfter));
    verifyOwnedObservation(before,afterApply,ownedId,objectBefore,objectAfter,serial);
    NSArray *during = observeOwnedMode(display, ownedId, serial, before); report[@"during"] = during;
    if (!preserves(before, during, ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_CREATION");
    NSDictionary *actual = findDisplay(during, ownedId), *rect = actual[@"bounds"];
    if (![actual[@"online"] boolValue] || ![actual[@"active"] boolValue] || [actual[@"mirrored"] boolValue] || [actual[@"vendor"] unsignedIntValue] != 505 || [actual[@"serial"] unsignedIntValue] != serial || [actual[@"modeWidth"] intValue] != 1920 || [actual[@"modeHeight"] intValue] != 1080 || [actual[@"pixelWidth"] intValue] != 1920 || [actual[@"pixelHeight"] intValue] != 1080 || [rect[@"width"] intValue] != 1920 || [rect[@"height"] intValue] != 1080) fail(@"OWNED_DISPLAY_MODE_OR_IDENTITY_MISMATCH");
    report[@"phase"] = @"owned-mode-observed"; saveReport();
    report[@"windowPlacement"] = placeOwnedWindow(ownedId);
    mark=beginQuery();objectBefore=display.displayID;report[@"afterWindow"] = inventory();objectAfter=display.displayID;
    recordStage(@"after-window",report[@"afterWindow"],before,ownedId,endQuery(mark,objectBefore,objectAfter));
    if (!preserves(before, report[@"afterWindow"], ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_WINDOW_PLACEMENT");
    if(objectBefore!=ownedId || objectAfter!=ownedId)fail(@"OWNED_DISPLAY_ID_CHANGED");checkDiagnosticHealth();
    report[@"phase"] = @"owned-window-placed"; saveReport();
  } @catch (NSException *exception) {
    if (![report[@"outcome"] isEqual:@"unsupported"]) report[@"outcome"] = @"failed";
    NSString *code=[exception.name isEqual:@"ProbeFailure"] ? exception.reason : @"NATIVE_EXCEPTION";
    if(!report[@"code"])report[@"code"]=code;
    report[@"primaryCode"] = report[@"code"]; report[@"failurePhase"] = report[@"phase"] ?: @"baseline";
  } @finally {
    // The only destruction operation: drop this process's one owned object.
    // No public mode-setting, CGConfigure or restore call targets any display.
    diagnosticPhase(9);if(observerInitialized)topology[@"releaseStartNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)monotonicNS()];
    display = nil;
    report[@"phase"] = @"owned-object-released"; saveReport();
    if (before) {
      @try {
        diagnosticPhase(10);
        // A just-released owned ID may remain online briefly without a mode.
        // It must disappear; existing IDs still require their original modes.
        uint32_t retiringId = initialized && ownedId && !findDisplay(before, ownedId) ? ownedId : 0;
        NSTimeInterval start = NSProcessInfo.processInfo.systemUptime;
        __block unsigned int polls = 0;
        NSMutableArray *observations = [NSMutableArray array];
        report[@"cleanupObservations"] = observations; report[@"cleanupWaitBudgetSeconds"] = @15;
        BOOL cleaned = waitUntil(15, ^BOOL{
          ROQuery queryStart=beginQuery();
          NSArray *current = inventoryForOwned(retiringId);
          NSDictionary *queryMark=endQuery(queryStart,0,0);
          if(!topology[@"firstCleanupQuery"]) {
            report[@"firstCleanupInventory"]=current;
            topology[@"firstCleanupQuery"]=queryObservation(current,before,retiringId,queryMark,@"native.firstCleanupInventory");
          }
          topology[@"lastCleanupQuery"]=queryObservation(current,before,retiringId,queryMark,@"native.lastCleanup");
          report[@"lastCleanup"] = current; report[@"cleanupPollCount"] = @(++polls);
          report[@"cleanupWaitElapsedSeconds"] = @(NSProcessInfo.processInfo.systemUptime - start);
          NSDictionary *owned = retiringId ? findDisplay(current, retiringId) : nil;
          NSDictionary *state = @{@"ownedIdPresent":owned ? @YES : @NO,
                                  @"ownedModeAvailable":owned[@"modeAvailable"] ?: NSNull.null,
                                  @"preexistingMatches":preserves(before, current, retiringId) ? @YES : @NO};
          if (![observations.lastObject[@"state"] isEqual:state] && observations.count < 16)
            [observations addObject:@{@"elapsedSeconds":report[@"cleanupWaitElapsedSeconds"], @"state":state}];
          return [before isEqual:current];
        });
        NSArray *after = inventoryForOwned(retiringId);
        BOOL verified = cleaned && [before isEqual:after];
        report[@"after"] = after; report[@"cleanupVerified"] = @(verified);
        report[@"cleanupWaitElapsedSeconds"] = @(NSProcessInfo.processInfo.systemUptime - start);
        if (!verified) {
          report[@"outcome"] = @"failed"; report[@"cleanupCode"] = @"CLEANUP_OR_PREEXISTING_STATE_MISMATCH";
          if (!report[@"code"]) report[@"code"] = report[@"cleanupCode"];
        }
      } @catch (NSException *exception) {
        (void)exception; report[@"cleanupVerified"] = @NO; report[@"outcome"] = @"failed";
        report[@"cleanupCode"] = @"CLEANUP_INVENTORY_UNAVAILABLE";
        if (!report[@"code"]) report[@"code"] = report[@"cleanupCode"];
      }
    }
    if (interrupted) {
      report[@"outcome"] = @"failed"; report[@"interruptionCode"] = @"INTERRUPTED";
      if (!report[@"code"]) report[@"code"] = report[@"interruptionCode"];
    }
    finishObserver();
    if(traceOutputFailure)noteFailure(traceOutputFailure,@"diagnosticCode");
    if(nativeOutputFailure)noteFailure(nativeOutputFailure,@"outputCode");
    if (initialized && !report[@"code"] && [report[@"cleanupVerified"] boolValue]) report[@"outcome"] = @"passed";
    report[@"phase"] = @"complete"; saveReport();
    // A final persistence failure must make the process fail even if an earlier
    // complete-looking file existed. Preserve the native primary failure.
    if(traceOutputFailure || nativeOutputFailure) {
      if(traceOutputFailure)noteFailure(traceOutputFailure,@"diagnosticCode");
      if(nativeOutputFailure)noteFailure(nativeOutputFailure,@"outputCode");
      saveReport();
    }
  }
  return [report[@"outcome"] isEqual:@"passed"] ? 0 : [report[@"outcome"] isEqual:@"unsupported"] ? 78 : 1;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL inventoryOnly = argc == 3 && !strcmp(argv[1], "--inventory-ci");
    if (argc != 3 || (!inventoryOnly && strcmp(argv[1], "--exercise-ci"))) { fprintf(stderr, "CI-only helper; --exercise-ci or --inventory-ci RESULT_JSON required\n"); return 64; }
    outputPath = [NSString stringWithUTF8String:argv[2]];
#if defined(__arm64__)
    NSString *architecture = @"arm64";
#elif defined(__x86_64__)
    NSString *architecture = @"x64";
#else
    NSString *architecture = @"unsupported";
#endif
    NSDictionary *environment = NSProcessInfo.processInfo.environment;
    report = [@{@"schema":@1, @"outcome":@"not-run", @"runId":environment[@"REVIEWOPS_PROBE_RUN_ID"] ?: @"", @"source":environment[@"GITHUB_SHA"] ?: @"", @"createdDisplays":@0, @"settingsApplyCalls":@0, @"ownedModeSetCalls":@0, @"capturedFrames":@0, @"injectedInputs":@0, @"requestedPermissions":@0, @"privateUnsupportedAPI":@YES, @"architecture":architecture, @"os":NSProcessInfo.processInfo.operatingSystemVersionString} mutableCopy];
    NSString *refusal = executionRefusal();
    if (refusal) { report[@"outcome"] = @"refused"; report[@"code"] = refusal; saveReport(); return 77; }
    if (inventoryOnly) {
      // Independent public inventory does not register an observer or load any
      // trace atomics. Persistence failure still fails this separate process.
      @try {
        report[@"outcome"] = @"inventory"; report[@"displays"] = inventory(); saveReport();
        if(nativeOutputFailure){noteFailure(nativeOutputFailure,@"outputCode");saveReport();return 1;}
        return 0;
      }
      @catch (NSException *exception) { (void)exception; report[@"outcome"] = @"failed"; report[@"code"] = @"INVENTORY_FAILED"; saveReport(); return 1; }
    }
    signal(SIGTERM, stopProbe); signal(SIGINT, stopProbe);
    return exercise();
  }
}
