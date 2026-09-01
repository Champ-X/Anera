export const ANERA_DEV_PROXY_TARGET = 'http://127.0.0.1:4174'

const agentServerProxy = () => ({
  target: ANERA_DEV_PROXY_TARGET,
  // Preserve the browser-facing Host so the Agent server can compare it with
  // Origin. Vite's string shorthand forces changeOrigin=true and makes every
  // same-origin browser mutation look cross-origin to the CSRF guard.
  changeOrigin: false,
})

export const ANERA_DEV_PROXY = {
  '/api': agentServerProxy(),
  '/nextjs-api': agentServerProxy(),
  '/workspace': agentServerProxy(),
}
