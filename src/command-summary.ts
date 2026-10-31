// Summaries hide shell launchers only; tool details retain the original command.
export function commandSummary(value: unknown): string {
  if (Array.isArray(value)) {
    const [shell, ...args] = value.map(String)
    const flag = args.findIndex(arg => /^(?:-command|-c|-lc|\/c)$/i.test(arg))
    if (shell && /(?:^|[\\/])(?:powershell|pwsh|bash|sh|cmd)(?:\.exe)?$/i.test(shell) && flag >= 0) {
      return args.slice(flag + 1).join(' ').replace(/\s+/g, ' ').trim()
    }
    return value.map(String).join(' ').replace(/\s+/g, ' ').trim()
  }
  if (typeof value !== 'string') return ''
  let text = value.trim()
  for (let depth = 0; depth < 3; depth++) {
    const match = text.match(/^(?:&\s*)?(?:"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?'|(?:[^\s"']*[\\/])?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?)\s+((?:(?:-NoProfile|-NonInteractive|-NoLogo|-Login|-l|-i|\/d|\/s|-ExecutionPolicy\s+\S+|-InputFormat\s+\S+|-OutputFormat\s+\S+)\s+)*)(?:-Command|-c|-lc|\/c)\s+([\s\S]+)$/i)
    if (!match) break
    text = match[2]!.trim()
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) text = text.slice(1, -1)
  }
  return text.replace(/\s+/g, ' ').trim()
}
