import { useEffect, useState, type CSSProperties } from 'react'
import { bundledLanguages, createHighlighter, knows } from '../diff/shiki'
import { pierreThemes } from '../diff/themes'

const THEMES = { light: 'pierre-light', dark: 'pierre-dark' } as const
const CACHE_LIMIT = 200

type Tokens = Awaited<ReturnType<Awaited<ReturnType<typeof createHighlighter>>['codeToTokens']>>['tokens']

const cache = new Map<string, Tokens>()
let highlighter: ReturnType<typeof createHighlighter> | undefined

const themeLoaders = () => Object.values(THEMES).map((name) => pierreThemes.getTheme(name)!.load)

async function tokenise(code: string, language: string): Promise<Tokens> {
  const lang = knows(language) ? (language as keyof typeof bundledLanguages) : 'text'
  const key = `${lang}\0${THEMES.light}\0${THEMES.dark}\0${code}`
  const hit = cache.get(key)
  if (hit) return hit
  highlighter ??= createHighlighter({ themes: themeLoaders(), langs: [] })
  const one = await highlighter
  if (lang !== 'text') await one.loadLanguage(lang)
  const { tokens } = one.codeToTokens(code, { lang, themes: THEMES, defaultColor: false })
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, tokens)
  return tokens
}

/** The code as coloured spans. Until the tokens are ready it is the plain text; a failure goes to the boundary. */
export default function Highlighted(props: { code: string; language: string }) {
  const { code, language } = props
  const [tokens, setTokens] = useState<Tokens | null>(null)
  const [, fail] = useState()
  useEffect(() => {
    let live = true
    tokenise(code, language).then(
      (next) => live && setTokens(next),
      (cause: unknown) => live && fail(() => { throw cause }),
    )
    return () => {
      live = false
    }
  }, [code, language])

  return (
    <pre className="chat__code-body">
      <code>
        {tokens === null
          ? code
          : tokens.map((line, row) => (
              <span className="chat__code-line" key={row}>
                {line.map((token, col) => (
                  <span key={col} style={token.htmlStyle as CSSProperties}>
                    {token.content}
                  </span>
                ))}
                {'\n'}
              </span>
            ))}
      </code>
    </pre>
  )
}
