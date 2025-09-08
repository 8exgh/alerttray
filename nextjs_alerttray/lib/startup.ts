import { ProjectionEngine } from './cqrs/projection-engine';

let projectionEngine: ProjectionEngine | null = null;

export async function initializeSystem(): Promise<void> {
  if (projectionEngine) {
    return; // Already initialized
  }
  
  console.log('Initializing AlertTray system...');
  
  // Start projection engine
  projectionEngine = new ProjectionEngine();
  await projectionEngine.start();
  
  console.log('Projection engine started');
  
  // Clean up on process termination
  process.on('SIGINT', () => {
    console.log('Shutting down projection engine...');
    if (projectionEngine) {
      projectionEngine.stop();
    }
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('Shutting down projection engine...');
    if (projectionEngine) {
      projectionEngine.stop();
    }
    process.exit(0);
  });
}

export function getProjectionEngine(): ProjectionEngine | null {
  return projectionEngine;
}