// Private-API lifecycle experiment, never a shipping ReviewOps provider.
#import "private-interface.h"
#import <objc/runtime.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

#ifndef REVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION
#define REVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION 0
#endif

static volatile sig_atomic_t interrupted = 0;
static void stopProbe(int signalNumber) { (void)signalNumber; interrupted = 1; }
static NSString *outputPath;
static NSMutableDictionary *report;
static void saveReport(void) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];
  if (bytes.length > 128 * 1024 || ![bytes writeToFile:outputPath atomically:YES]) {
    fprintf(stderr, "Unable to write bounded probe result\n");
  }
}
static void fail(NSString *code) {
  @throw [NSException exceptionWithName:@"ProbeFailure" reason:code userInfo:nil];
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
      if (ident != pendingOwnedId) { saveReport(); fail(@"PREEXISTING_DISPLAY_MODE_UNAVAILABLE"); }
    }
    [items addObject:@{
      @"id":@(ident), @"bounds":bounds(CGDisplayBounds(ident)),
      @"online":@(CGDisplayIsOnline(ident)), @"active":@(CGDisplayIsActive(ident)),
      @"mirrored":@(CGDisplayIsInMirrorSet(ident)), @"main":@(CGDisplayIsMain(ident)),
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
  while (!interrupted && NSProcessInfo.processInfo.systemUptime < deadline) {
    NSArray *current = inventoryForOwned(ownedId);
    report[@"lastDuring"] = current;
    report[@"modePollCount"] = @(++polls);
    report[@"modeWaitElapsedSeconds"] = @(NSProcessInfo.processInfo.systemUptime - start);
    if (!preserves(before, current, ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_MODE_TRANSITION");
    NSDictionary *owned = findDisplay(current, ownedId);
    id observed = owned ?: NSNull.null;
    if (![observations.lastObject[@"display"] isEqual:observed] && observations.count < 16) {
      [observations addObject:@{@"elapsedSeconds":report[@"modeWaitElapsedSeconds"], @"display":observed}]; saveReport();
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
    before = inventory(); report[@"before"] = before; report[@"phase"] = @"baseline"; saveReport();
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
    report[@"phase"] = @"creating-owned-display"; saveReport();
    display = [[displayClass alloc] initWithDescriptor:descriptor];
    if (!display) fail(@"OWNED_DISPLAY_CREATION_FAILED");
    initialized = YES; ownedId = display.displayID; report[@"createdDisplays"] = @1; report[@"ownedDisplayId"] = @(ownedId); saveReport();
    if (!ownedId || findDisplay(before, ownedId)) fail(@"OWNED_DISPLAY_ID_INVALID_OR_PREEXISTING");
    id<ROVirtualSettings> settings = [settingsClass new]; [settings setHiDPI:0];
    id<ROVirtualMode> mode = [[modeClass alloc] initWithWidth:1920 height:1080 refreshRate:60];
    if (!mode) fail(@"OWNED_MODE_CREATION_FAILED");
    [settings setModes:@[mode]]; if (![display applySettings:settings]) fail(@"OWNED_SETTINGS_REJECTED");
    NSArray *during = observeOwnedMode(display, ownedId, serial, before); report[@"during"] = during;
    if (!preserves(before, during, ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_CREATION");
    NSDictionary *actual = findDisplay(during, ownedId), *rect = actual[@"bounds"];
    if (![actual[@"online"] boolValue] || ![actual[@"active"] boolValue] || [actual[@"mirrored"] boolValue] || [actual[@"vendor"] unsignedIntValue] != 505 || [actual[@"serial"] unsignedIntValue] != serial || [actual[@"modeWidth"] intValue] != 1920 || [actual[@"modeHeight"] intValue] != 1080 || [actual[@"pixelWidth"] intValue] != 1920 || [actual[@"pixelHeight"] intValue] != 1080 || [rect[@"width"] intValue] != 1920 || [rect[@"height"] intValue] != 1080) fail(@"OWNED_DISPLAY_MODE_OR_IDENTITY_MISMATCH");
    report[@"phase"] = @"owned-mode-observed"; saveReport();
    report[@"windowPlacement"] = placeOwnedWindow(ownedId);
    report[@"afterWindow"] = inventory();
    if (!preserves(before, report[@"afterWindow"], ownedId)) fail(@"PREEXISTING_DISPLAYS_CHANGED_DURING_WINDOW_PLACEMENT");
    report[@"phase"] = @"owned-window-placed"; saveReport();
  } @catch (NSException *exception) {
    if (![report[@"outcome"] isEqual:@"unsupported"]) report[@"outcome"] = @"failed";
    report[@"code"] = [exception.name isEqual:@"ProbeFailure"] ? exception.reason : @"NATIVE_EXCEPTION";
    report[@"primaryCode"] = report[@"code"]; report[@"failurePhase"] = report[@"phase"] ?: @"baseline";
  } @finally {
    // The only destruction operation: drop this process's one owned object.
    // No public mode-setting, CGConfigure or restore call targets any display.
    display = nil;
    report[@"phase"] = @"owned-object-released"; saveReport();
    if (before) {
      @try {
        BOOL cleaned = waitUntil(15, ^BOOL{ return [before isEqual:inventory()]; });
        report[@"after"] = inventory(); report[@"cleanupVerified"] = @(cleaned);
        if (!cleaned) { report[@"outcome"] = @"failed"; report[@"code"] = @"CLEANUP_OR_PREEXISTING_STATE_MISMATCH"; }
      } @catch (NSException *exception) { (void)exception; report[@"cleanupVerified"] = @NO; report[@"outcome"] = @"failed"; report[@"code"] = @"CLEANUP_INVENTORY_UNAVAILABLE"; }
    }
    if (interrupted) { report[@"outcome"] = @"failed"; report[@"code"] = @"INTERRUPTED"; }
    if (initialized && !report[@"code"] && [report[@"cleanupVerified"] boolValue]) report[@"outcome"] = @"passed";
    report[@"phase"] = @"complete"; saveReport();
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
    report = [@{@"schema":@1, @"outcome":@"not-run", @"runId":environment[@"REVIEWOPS_PROBE_RUN_ID"] ?: @"", @"source":environment[@"GITHUB_SHA"] ?: @"", @"createdDisplays":@0, @"ownedModeSetCalls":@0, @"capturedFrames":@0, @"injectedInputs":@0, @"requestedPermissions":@0, @"privateUnsupportedAPI":@YES, @"architecture":architecture, @"os":NSProcessInfo.processInfo.operatingSystemVersionString} mutableCopy];
    NSString *refusal = executionRefusal();
    if (refusal) { report[@"outcome"] = @"refused"; report[@"code"] = refusal; saveReport(); return 77; }
    if (inventoryOnly) {
      @try { report[@"outcome"] = @"inventory"; report[@"displays"] = inventory(); saveReport(); return 0; }
      @catch (NSException *exception) { (void)exception; report[@"outcome"] = @"failed"; report[@"code"] = @"INVENTORY_FAILED"; saveReport(); return 1; }
    }
    signal(SIGTERM, stopProbe); signal(SIGINT, stopProbe);
    return exercise();
  }
}
