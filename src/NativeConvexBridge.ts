import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  applyDelta(jsonString: string): Promise<boolean>;
}

// Optional native module — missing on JS-only reloads / old binaries.
export default TurboModuleRegistry.get<Spec>('ConvexBridge') ?? null;
