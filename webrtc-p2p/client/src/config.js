// Signaling server URL — swap to wss:// in Phase 7 (production)
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:8080';
