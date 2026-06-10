#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ConvexBridge, NSObject)

RCT_EXTERN_METHOD(applyDelta:(NSString *)jsonString
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

@end
