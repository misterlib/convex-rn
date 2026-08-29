import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  applyDelta(jsonString: string): Promise<boolean>;
}

/** Kept so RN codegen sees TurboModuleRegistry.get<Spec>('ConvexBridge'). */
export function loadNativeConvexBridge(): Spec | null {
  return TurboModuleRegistry.get<Spec>('ConvexBridge') ?? null;
}

// Do not call loadNativeConvexBridge() at import time. get() constructs the
// native module; on iOS 26/27 ConvexBridge.init() asserts (EXC_BREAKPOINT)
// when App Group group.com.convexrn.shared is missing.
const nativeBridge: Spec | null = null;
export default nativeBridge;
