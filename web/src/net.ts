// The browser's own fetch, saved before api.ts wraps it, for calls that must not be routed anywhere else
// (the relay database itself, and this device's own server while you are in someone else's workspace).
export const nativeFetch: typeof fetch = window.fetch.bind(window);
