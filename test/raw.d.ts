// Vite `?raw` imports (used by tests to read static files as strings).
declare module "*?raw" {
  const content: string;
  export default content;
}
