import type { TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  applyDelta(jsonString: string): Promise<boolean>;
}

// Do not call TurboModuleRegistry.get('ConvexBridge') here.
// get() constructs the native module; on iOS 26/27 ConvexBridge.init()
// asserts (EXC_BREAKPOINT / SIGTRAP) when App Group
// group.com.convexrn.shared is missing. JS cache still works without it.
const nativeBridge: Spec | null = null;
export default nativeBridge;
