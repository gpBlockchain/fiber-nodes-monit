function fallbackCopy(text: string) {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  } catch (err) {
    console.error('Fallback copy failed:', err)
    alert('Copy failed')
  }
}

/** Copy plain text to clipboard (async API with textarea fallback). */
export function copyToClipboard(text: string) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('Clipboard write failed, trying fallback:', err)
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}
