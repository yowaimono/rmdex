import { registerDesktopContext } from '../server/desktop-context.ts'

try {
  await registerDesktopContext()
  console.log('Desktop 已在本机连接 rmdex，连接信息已用当前 Windows 用户身份加密。')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Desktop 注册失败')
  process.exitCode = 1
}
