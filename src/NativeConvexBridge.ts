import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  applyDelta(jsonString: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ConvexBridge');
