export const CLIENT_VERSION = 1;
export const MAX_CLIENT_REQUEST_BYTES = 128 * 1024;
export const MAX_CLIENT_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENT_CONTENT_BYTES = 64 * 1024;

export const CLIENT_RESOURCES = Object.freeze({
  connections: 32, hostWatches: 8, principalWatches: 2,
  requestMs: 5000, operationMs: 60000, backpressureMs: 5000, viewerMs: 15 * 60 * 1000,
  headerBytes: 8192, headerCheckMs: 1000, requestsPerSocket: 1,
  collectionItems: 8192, jsonValues: 131072, jsonDepth: 64,
  cursorSlots: 128, cursorMs: 5 * 60 * 1000,
});
