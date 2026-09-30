/** Friday 自己的页面：打包版的 tauri 来源，开发时 vite 的本机端口 */
export const isLocalOrigin = (origin: string) => /^(tauri:\/\/localhost|http:\/\/tauri\.localhost|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin) ? origin : "";
