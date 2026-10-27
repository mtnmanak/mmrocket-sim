/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** The vendored brand tokens (public/brand/tokens.json), served by vite.config's brandTokensModule. */
declare module 'virtual:mmr-brand-tokens' {
  const tokens: typeof import('../public/brand/tokens.json');
  export default tokens;
}
