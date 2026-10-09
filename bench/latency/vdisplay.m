// vdisplay: a virtual monitor through CoreGraphics' private CGVirtualDisplay API (the one DeskPad
// uses), so benchmark windows could be on screen without covering the user's own displays.
//
//   vdisplay --probe                                  is the API there? creates nothing
//   vdisplay --create [--width 1728 --height 1117 --hz 120 --hold 600]
//
// --create adds a display to the arrangement (the user sees it in System Settings, and the
// window server reconfigures), prints its id and bounds, and removes it on exit or after --hold s.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) unsigned int displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

static NSString *option(NSArray<NSString *> *args, NSString *name, NSString *fallback) {
  NSUInteger index = [args indexOfObject:name];
  return index != NSNotFound && index + 1 < args.count ? args[index + 1] : fallback;
}

static void print(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
  printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  fflush(stdout);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    NSDictionary *api = @{
      @"CGVirtualDisplay": @(NSClassFromString(@"CGVirtualDisplay") != nil &&
                             [NSClassFromString(@"CGVirtualDisplay") instancesRespondToSelector:@selector(initWithDescriptor:)] &&
                             [NSClassFromString(@"CGVirtualDisplay") instancesRespondToSelector:@selector(applySettings:)]),
      @"CGVirtualDisplayDescriptor": @(NSClassFromString(@"CGVirtualDisplayDescriptor") != nil &&
                                       [NSClassFromString(@"CGVirtualDisplayDescriptor") instancesRespondToSelector:@selector(setTerminationHandler:)]),
      @"CGVirtualDisplayMode": @([NSClassFromString(@"CGVirtualDisplayMode") instancesRespondToSelector:@selector(initWithWidth:height:refreshRate:)]),
      @"CGVirtualDisplaySettings": @([NSClassFromString(@"CGVirtualDisplaySettings") instancesRespondToSelector:@selector(setModes:)])
    };
    if ([args containsObject:@"--probe"]) {
      print(@{@"api": api, @"created": @NO});
      return 0;
    }
    if (![args containsObject:@"--create"]) {
      fprintf(stderr, "usage: vdisplay --probe | --create [--width W --height H --hz HZ --hold S]\n");
      return 2;
    }
    unsigned int width = (unsigned int)option(args, @"--width", @"1728").intValue;
    unsigned int height = (unsigned int)option(args, @"--height", @"1117").intValue;
    double hz = option(args, @"--hz", @"120").doubleValue;
    double hold = option(args, @"--hold", @"600").doubleValue;

    CGVirtualDisplayDescriptor *descriptor = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
    descriptor.queue = dispatch_get_main_queue();
    descriptor.name = @"Pod bench display";
    // HiDPI: the backing store is twice the point size, like the built-in Retina panel.
    descriptor.maxPixelsWide = width * 2;
    descriptor.maxPixelsHigh = height * 2;
    descriptor.sizeInMillimeters = CGSizeMake(width * 0.2, height * 0.2);
    descriptor.vendorID = 0x3456;
    descriptor.productID = 0x1234;
    descriptor.serialNum = 0x0001;
    descriptor.terminationHandler = ^(id display, id error) {
      exit(3);
    };
    CGVirtualDisplay *display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    CGVirtualDisplaySettings *settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
    settings.hiDPI = 1;
    settings.modes = @[[[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:hz]];
    BOOL applied = [display applySettings:settings];
    // The window server needs a moment to publish the new display's geometry.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
    CGDirectDisplayID id = display.displayID;
    CGRect bounds = CGDisplayBounds(id);
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id);
    print(@{
      @"api": api,
      @"created": @(id != 0 && applied),
      @"displayID": @(id),
      @"bounds": @[@(bounds.origin.x), @(bounds.origin.y), @(bounds.size.width), @(bounds.size.height)],
      @"refreshHz": @(mode ? CGDisplayModeGetRefreshRate(mode) : 0),
      @"pixels": @[@(mode ? CGDisplayModeGetPixelWidth(mode) : 0), @(mode ? CGDisplayModeGetPixelHeight(mode) : 0)],
      @"holdSeconds": @(hold)
    });
    if (mode) CGDisplayModeRelease(mode);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:hold]];
  }
  return 0;
}
