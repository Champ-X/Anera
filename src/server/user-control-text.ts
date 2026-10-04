/** Reserved provider control boundaries are server-authored, never user text. */
export function escapeUntrustedArenaControlText(content: string): string {
  return content
    .replace(/<arena-system-message>/gi, '&lt;arena-system-message&gt;')
    .replace(/<\/arena-system-message>/gi, '&lt;/arena-system-message&gt;')
    .replace(/Uploaded workspace files:/gi, 'Uploaded workspace files&#58;')
    .replace(/The next message part will be the user providing feedback about the previous message\./gi, 'The next message part will be the user providing feedback about the previous message&#46;')
}
