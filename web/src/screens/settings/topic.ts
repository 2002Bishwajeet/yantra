const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const HOST = 'ntfy.sh'

/** 128 random bits as 26 base32 characters, inside ntfy's `[-_A-Za-z0-9]{1,64}`. */
export function newTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let bits = 0
  let held = 0
  let out = ''
  for (const byte of bytes) {
    bits = (bits << 8) | byte
    held += 8
    while (held >= 5) {
      out += ALPHABET[(bits >>> (held - 5)) & 31]
      held -= 5
    }
    bits &= (1 << held) - 1
  }
  if (held > 0) out += ALPHABET[(bits << (5 - held)) & 31]
  return `yantra-${out}`
}

export const topicUrl = (topic: string) => `https://${HOST}/${topic}`

export const subscribeLink = (topic: string) => `ntfy://${HOST}/${topic}`

/** The topic when `url` is a topic on the public ntfy server, else null. */
export function publicTopic(url: string): string | null {
  const match = new RegExp(`^https://${HOST.replace('.', '\\.')}/([-_A-Za-z0-9]{1,64})$`).exec(url.trim())
  return match ? match[1] : null
}
