// Experimental private ABI declarations adapted from Chromium's test interfaces.
// Copyright 2022 The Chromium Authors. See CHROMIUM-LICENSE in this directory.
// These are NOT declarations of an Apple-supported public API.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

@protocol ROVirtualDescriptor <NSObject>
- (void)setName:(NSString *)name;
- (void)setQueue:(id)queue;
- (void)setMaxPixelsWide:(unsigned int)value;
- (void)setMaxPixelsHigh:(unsigned int)value;
- (void)setVendorID:(unsigned int)value;
- (void)setProductID:(unsigned int)value;
- (void)setSerialNum:(unsigned int)value;
- (void)setSerialNumber:(unsigned int)value;
- (void)setSizeInMillimeters:(CGSize)value;
- (void)setRedPrimary:(CGPoint)value;
- (void)setGreenPrimary:(CGPoint)value;
- (void)setBluePrimary:(CGPoint)value;
- (void)setWhitePoint:(CGPoint)value;
@end

@protocol ROVirtualMode <NSObject>
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end

@protocol ROVirtualSettings <NSObject>
- (void)setModes:(NSArray *)modes;
- (void)setHiDPI:(unsigned int)value;
@end

@protocol ROVirtualDisplay <NSObject>
- (id)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
- (unsigned int)displayID;
@end
