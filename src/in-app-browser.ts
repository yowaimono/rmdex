import { Capacitor, registerPlugin } from '@capacitor/core'

const browser = registerPlugin<{ open(options: { url: string }): Promise<void> }>('RmdexBrowser')

export function webLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

export function installInAppLinks(onError: (message: string) => void) {
  const click = (event: MouseEvent) => {
    if (Capacitor.getPlatform() !== 'android' || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const anchor = (event.target instanceof Element ? event.target : null)?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || anchor.hasAttribute('download')) return
    const url = webLink(anchor.getAttribute('href') || '')
    if (!url) return
    event.preventDefault()
    void browser.open({ url }).catch(() => onError('应用内网页暂时无法打开，请确认已更新 Android 客户端后重试'))
  }
  document.addEventListener('click', click)
  return () => document.removeEventListener('click', click)
}
