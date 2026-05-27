function getElectronClipboard () {
  try {
    // eslint-disable-next-line
    const electron = (typeof window !== 'undefined' && window.require) ? window.require('electron') : require('electron')
    return electron && electron.clipboard ? electron.clipboard : null
  } catch (err) {
    return null
  }
}

function copyViaTextarea (text) {
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch (err) {
    ok = false
  } finally {
    document.body.removeChild(textarea)
  }
  return !!ok
}

export async function copyTextReliable (text) {
  const safeText = String(text || '')
  if (!safeText) return { ok: false, method: null }

  const electronClipboard = getElectronClipboard()
  if (electronClipboard) {
    try {
      electronClipboard.writeText(safeText)
      const verify = electronClipboard.readText()
      if (verify === safeText) return { ok: true, method: 'electron' }
    } catch (err) {}
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(safeText)
      return { ok: true, method: 'navigator' }
    } catch (err) {}
  }

  if (copyViaTextarea(safeText)) return { ok: true, method: 'execCommand' }
  return { ok: false, method: null }
}

export async function readTextReliable () {
  const electronClipboard = getElectronClipboard()
  if (electronClipboard) {
    try {
      const text = electronClipboard.readText()
      if (typeof text === 'string' && text.trim() !== '') {
        return { ok: true, method: 'electron', text }
      }
    } catch (err) {}
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText()
      return { ok: true, method: 'navigator', text: String(text || '') }
    } catch (err) {}
  }

  return { ok: false, method: null, text: '' }
}
