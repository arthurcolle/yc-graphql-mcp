import { createYCGraphQLClient, type YCGraphQLClient } from './client.js';

declare global {
  interface Window {
    ycGraphQL: YCGraphQLClient;
  }
}

// Installation itself performs no requests or application edits.
Object.defineProperty(window, 'ycGraphQL', {
  configurable: true,
  value: createYCGraphQLClient(window),
});
