/**
 * Web stub for NativeConvexBridge.
 * TurboModules are not available on web, so this always returns null.
 */

export interface Spec {
  applyDelta(jsonString: string): Promise<boolean>;
}

export function loadNativeConvexBridge(): Spec | null {
  return null;
}

const nativeBridge: Spec | null = null;
export default nativeBridge;
