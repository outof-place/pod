#pragma once
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block`, catching an Objective-C exception (CoreSimulator's remote proxies raise them when a
/// private selector moved) so it becomes an error instead of a crash. NO with `reason` set on a raise.
BOOL PodSimObjCTry(NS_NOESCAPE void (^block)(void), NSString *_Nullable *_Nullable reason);

NS_ASSUME_NONNULL_END
